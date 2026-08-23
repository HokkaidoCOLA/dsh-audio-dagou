/**
 * dsh-audio-dagou — 给 DeepSeek Harness（DSH）会话配音效的宿主插件。
 *
 * 行为（用户需求）：
 *   1. 模型每执行一条命令（`bash` 工具调用）后 → 播放「大狗.wav」，并把命令计数 +1；
 *   2. 模型向用户提问（`ask_user_question` 工具调用）时 → 播放「叮咚鸡.wav」；
 *      注意时机在「提问瞬间」：挂在 `tools/execute`（批准后、工具体运行前）。
 *      `ask_user_question` 的 execute 会阻塞直到用户答完，若挂在 `tools/result`
 *      （执行结束的观测事件）声音会拖到回答完成之后才响；
 *   3. 用户回答完问题后 → 播放「诶.wav」（回答确认音，挂在 `tools/result`——
 *      此刻 == 工具刚返回、用户刚提交答案）；
 *   4. 每一轮用户请求（一个 agent turn）结束时 → 按本轮命令计数成正比地播放
 *      「叫.wav」，播放次数 = min(round(计数 × barkScale), maxBarks)（默认最多 10 声），
 *      随后把该 agent 的计数清零；
 *   5. 模型用 `read` 工具读取【会话工作区之外】的文件（读取成功时）→ 先播
 *      「叮咚鸡.wav」（与提问同款）、再播「诶.wav」（与回答确认音同款默认音效）：
 *      任一沙箱 mode 下读取都不受限，读出的内容可能来自工作区之外，读取成功
 *      的瞬间补一声提问式提醒 + 一声确认。默认音效即上两项；`soundReadOutside`
 *      可单独换掉「诶」，提问音跟随 `soundQuestion`。
 *
 * 实现要点（符合官方插件规范）：
 *   - Cordis 插件形态：导出 name / inject / Config / apply；
 *   - Config 用 schemastery 声明（loader 校验 + 填默认值）；
 *   - 事件订阅统一挂在 ctx.effect 上，热重载时自动清理；
 *   - 音频播放 fire-and-forget、永不阻塞也不抛错——声音故障绝不影响工具执行或
 *     agent 回合收尾（`agent/turn-stopping` 是串行且会被 await 的边界，因此
 *     「叫」的连播在后台异步进行，不在监听器内阻塞）；
 *   - 命令计数按 agent 隔离（tools/result 的 exec.agent 与 turn-stopping 的
 *     payload.agent 均带 agent 身份），避免 subagent 的回合把主 agent 的计数
 *     误清零、或为 subagent 的零命令回合触发多余的叫声。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent' // 引入 dsh-agent 的事件类型增强（agent/turn-stopping）
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-audio-dagou'
export const inject = ['tools']

/** 模型执行命令的工具名（dsh-tool-bash 注册）。 */
const BASH_TOOL = 'bash'
/** 模型向用户提问的工具名（dsh-tool-ask-user 注册）。 */
const ASK_USER_TOOL = 'ask_user_question'
/** 模型读取文本文件的工具名（dsh-tool-fs 注册）。 */
const READ_TOOL = 'read'

/** 插件自带音频资产目录（lib/../assets）。 */
const ASSETS_DIR = fileURLToPath(new URL('../assets/', import.meta.url))

/** 内置音效文件名：填这些名字即用插件自带资产，其余按路径处理。 */
const BUILTIN_SOUNDS = new Set(['大狗.wav', '叮咚鸡.wav', '诶.wav', '叫.wav'])

/**
 * 每 agent 命令计数的保留上限。
 *
 * 正常情况下每个 key 都会在 `agent/turn-stopping` 时被删除；但被强制中断、
 * 崩溃、或根本没走到 turn 边界的 agent 会留下孤儿键。长期运行的 host 里每个
 * subagent 的 id 都不同，不设上限则该 Map 会无界增长——超限时按插入序淘汰最旧的。
 */
const MAX_TRACKED_AGENTS = 256

export interface Config {
  /** 总开关：false 时全部静音（仍计数）。 */
  enabled: boolean
  /** 每执行一条命令后播放的音效。内置：`大狗.wav`；或填任意绝对路径。 */
  soundCommand: string
  /** 模型提问时播放的音效。内置：`叮咚鸡.wav`；或填任意绝对路径。 */
  soundQuestion: string
  /** 用户回答完问题后播放的音效。内置：`诶.wav`；或填任意绝对路径。 */
  soundAnswer: string
  /** 读工作区外文件时后播的音效（先播一声提问音 `soundQuestion`，再播它）。内置：`诶.wav`（回答确认音同款）；或填任意绝对路径。 */
  soundReadOutside: string
  /** 任务结束时连播的叫声音效。内置：`叫.wav`；或填任意绝对路径。 */
  soundBark: string
  /** 播放次数 = min(round(命令计数 × 该倍数), maxBarks)；默认 1（严格正比）。 */
  barkScale: number
  /** 每轮结束最多播放几次叫声（需求：≤10）。 */
  maxBarks: number
  /** 连播叫声之间间隔 ms（让每声可分辨）。 */
  barkGapMs: number
  /** 每声叫声可被截断的最长时长 ms；0 = 不截断。 */
  barkMaxMs: number
}

/** 配置声明：loader 在挂载前校验入口 config 并填入默认值。 */
export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  soundCommand: Schema.string().default('大狗.wav'),
  soundQuestion: Schema.string().default('叮咚鸡.wav'),
  soundAnswer: Schema.string().default('诶.wav'),
  soundReadOutside: Schema.string().default('诶.wav'),
  soundBark: Schema.string().default('叫.wav'),
  barkScale: Schema.number().min(0).step(0.1).default(1),
  maxBarks: Schema.number().min(1).max(100).step(1).default(10),
  barkGapMs: Schema.number().min(0).step(1).default(420),
  barkMaxMs: Schema.number().min(0).step(1).default(0),
})

/** 配置默认值（与 Config schema 的 default 一致；直接调用 apply 时兜底）。 */
const DEFAULTS: Config = {
  enabled: true,
  soundCommand: '大狗.wav',
  soundQuestion: '叮咚鸡.wav',
  soundAnswer: '诶.wav',
  soundReadOutside: '诶.wav',
  soundBark: '叫.wav',
  barkScale: 1,
  maxBarks: 10,
  barkGapMs: 420,
  barkMaxMs: 0,
}

/** 从 agent 对象取稳定 id；缺省回退 '?'。 */
function agentKey(agent: { id?: string } | null | undefined): string {
  return agent?.id ?? '?'
}

/** 解析音效配置：内置文件名 → 插件资产绝对路径；其余（绝对路径）原样使用。 */
function resolveSound(spec: string): string {
  if (!spec) return ''
  return BUILTIN_SOUNDS.has(spec) ? join(ASSETS_DIR, spec) : spec
}

/**
 * 对「可能不存在」的路径做尽可能深的真实路径解析：从最深的已存在祖先 realpath，
 * 再把剩余不存在的后缀拼回去。
 *
 * 用于把工作区根与读取目标都归一化，消除符号链接拼写差异（macOS 的 /tmp →
 * /private/tmp、工作区内指向工作区外的 symlink、别名等价根），避免误判归属。
 * 只在 `read` 工具的结果上调用（不是 bash 热路径），这里的同步系统调用可忽略。
 */
function realpathDeepest(input: string): string {
  let current = input
  const rest: string[] = []
  while (true) {
    try {
      const real = realpathSync(current)
      return rest.length > 0 ? join(real, ...rest) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return input // 连根都无法解析：退回词法路径
      rest.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * 判定 targetPath（相对或绝对路径）是否位于 workspaceRoot 之内（含根自身）。
 *
 * 与 dsh-tool-fs 的 `read` 工具同口径：相对路径以工作区为基解析；两侧都经
 * `realpathDeepest` 归一化后再比较（win32 大小写不敏感，其余平台敏感）。
 * 导出它是为了冒烟测试能直接覆盖判定逻辑（前缀误判 / 越级、symlink 别名、大小写）。
 */
export function isPathContained(workspaceRoot: string, targetPath: string): boolean {
  const root = realpathDeepest(resolve(workspaceRoot))
  const target = realpathDeepest(resolve(root, targetPath))
  const insensitive = process.platform === 'win32'
  const a = insensitive ? root.toLowerCase() : root
  const b = insensitive ? target.toLowerCase() : target
  if (b === a) return true
  const prefix = a.endsWith(sep) ? a : a + sep
  return b.startsWith(prefix)
}

/** 从工具 arguments 里取 `read` 的 file_path；缺失或非字符串时返回 null。 */
function readRequestedFilePath(argumentsValue: unknown): string | null {
  if (typeof argumentsValue !== 'object' || argumentsValue === null) return null
  const filePath = (argumentsValue as { file_path?: unknown }).file_path
  return typeof filePath === 'string' && filePath.length > 0 ? filePath : null
}

/**
 * 一个已解析、已校验的音效。
 *
 * 存在性在 apply 时判定一次并缓存：`tools/result` 是热路径（模型每执行一条
 * 命令都要过一遍），原实现每次播放前都做一次同步 existsSync——既在事件循环上
 * 压一次阻塞式系统调用，又会在路径配错时把同一行警告刷满整个会话日志。
 */
interface Sound {
  /** 解析后的绝对路径；空字符串 = 未配置。 */
  path: string
  /** apply 时文件是否存在；false 则该音效的所有播放静默跳过。 */
  ok: boolean
}

/** 解析并校验一个音效（同步 stat 全程只做这一次），缺失时只警告一次。 */
function prepareSound(spec: string, label: string): Sound {
  const path = resolveSound(spec)
  if (!path) return { path: '', ok: false }
  const ok = existsSync(path)
  if (!ok) console.warn(`[dsh-audio-dagou] ${label}音效文件不存在，相关播放将跳过：${path}`)
  return { path, ok }
}

/**
 * 给播放进程挂一个「最长播放时长」看门狗。
 * 子进程先自然退出就撤掉定时器；定时器 unref，避免一个待触发的 kill 把 host
 * 的退出硬拖 maxMs。
 * @param child 播放子进程。
 * @param maxMs 超时强杀毫秒数；<=0 表示不截断。
 */
function armKillTimer(child: ChildProcess, maxMs: number): void {
  if (maxMs <= 0) return
  const timer = setTimeout(() => child.kill(), maxMs)
  timer.unref?.()
  child.once('exit', () => clearTimeout(timer))
}

/**
 * 生成 Windows 播放脚本：一个 PowerShell 进程内播 times 声。
 * @param file 音频绝对路径。
 * @param times 播放次数。
 * @param gapMs 两声之间间隔（最后一声之后不等待）。
 * @returns PowerShell 命令串。
 */
function psPlayScript(file: string, times: number, gapMs: number): string {
  // 全限定类型名：PowerShell 无法解析未带 System. 前缀的 Media.SoundPlayer
  const player = `$p = New-Object System.Media.SoundPlayer '${file.replaceAll("'", "''")}';`
  if (times <= 1) return `${player} $p.PlaySync();`
  const gap = gapMs > 0
    ? ` if ($i -lt ${times - 1}) { Start-Sleep -Milliseconds ${Math.round(gapMs)} };`
    : ''
  return `${player} for ($i = 0; $i -lt ${times}; $i++) { $p.PlaySync();${gap} }`
}

/**
 * 启动一次播放，播放结束（自然退出或被截断）时回调 onDone；播放器缺失、spawn
 * 失败、全部候选播放器不可用时也回调——onDone 恰好触发一次，绝不抛错。
 * - darwin → afplay
 * - win32  → PowerShell SoundPlayer（System.Media.SoundPlayer）
 * - linux  → paplay（无则 pw-play，无则 aplay）
 * @param sound 已校验的音效（ok=false 直接结束）。
 * @param maxMs 播放超过该时长强制停止；0 = 不截断。
 * @param onDone 结束回调（用于串联下一段音效；fire-and-forget 调用方传空函数）。
 */
function spawnOnce(sound: Sound, maxMs: number, onDone: () => void): void {
  const done = ((): (() => void) => {
    let fired = false
    return (): void => {
      if (!fired) { fired = true; onDone() }
    }
  })()
  if (!sound.ok) {
    done()
    return
  }
  const file = sound.path
  try {
    if (process.platform === 'darwin') {
      const child = spawn('afplay', [file], { stdio: 'ignore' })
      child.on('error', done)
      child.once('exit', done)
      armKillTimer(child, maxMs)
      return
    }
    if (process.platform === 'win32') {
      const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psPlayScript(file, 1, 0)], { stdio: 'ignore' })
      child.on('error', done)
      child.once('exit', done)
      armKillTimer(child, maxMs)
      return
    }
    // linux：优先 PulseAudio → PipeWire → ALSA。
    const names = ['paplay', 'pw-play', 'aplay']
    const tryPlayer = (index: number): void => {
      if (index >= names.length) {
        done()
        return
      }
      const child = spawn(names[index], [file], { stdio: 'ignore' })
      child.on('error', () => tryPlayer(index + 1))
      child.once('exit', done)
      armKillTimer(child, maxMs)
    }
    tryPlayer(0)
  } catch {
    /* 任何播放异常都不向外抛 */
    done()
  }
}

/**
 * 播放一个音频文件：fire-and-forget、绝不抛错。
 * @param sound 已校验的音效。
 * @param maxMs 播放超过该时长强制停止；0 = 不截断。
 */
function playFile(sound: Sound, maxMs = 0): void {
  spawnOnce(sound, maxMs, () => { /* fire-and-forget */ })
}

/**
 * 顺序播放一组音效：前一段结束（或被跳过）后隔 gapMs 播下一段；全程后台进行、
 * fire-and-forget、绝不抛错。用于「读工作区外」这类需要两声叠加语义的事件
 * （先回答确认音、再提问音，两声之间有可感知的间隔）。
 * @param sounds 依次播放的音效（ok=false 的自动跳过）。
 * @param gapMs 两声之间间隔 ms。
 * @param maxMs 单个音效的最长播放时长；0 = 不截断。
 */
function playSequence(sounds: Sound[], gapMs = 150, maxMs = 0): void {
  const playIndex = (index: number): void => {
    if (index >= sounds.length) return
    const sound = sounds[index]
    if (!sound.ok) {
      playIndex(index + 1)
      return
    }
    spawnOnce(sound, maxMs, () => {
      if (index < sounds.length - 1) {
        const timer = setTimeout(() => playIndex(index + 1), gapMs)
        timer.unref?.() // 待触发的间隔不该拖住 host 退出
      }
    })
  }
  playIndex(0)
}

/**
 * 「叫」的连播控制器（每个 apply 一个实例）。
 *
 * 连播在后台进行，绝不阻塞 `agent/turn-stopping`（那是个串行且被 await 的边界）；
 * 同一时刻只允许一轮，避免主 agent 与 subagent 的回合叠成噪音。
 * @returns 控制器：play 发起连播，dispose 在热重载/卸载时中断。
 */
function createBarkChain() {
  let running = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let currentChild: ChildProcess | null = null
  let resolveDispose: (() => void) | null = null
  // 一旦 dispose 即 resolve：让「挂在 sleep 上的循环」立即醒过来退出，
  // 否则被清除的定时器会让该 Promise 永不 settle，异步循环永久悬挂。
  const disposedPromise = new Promise<void>((resolve) => { resolveDispose = resolve })

  /** 可被 dispose 打断的等待。 */
  const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
    timer.unref?.() // 待触发的间隔不该拖住 host 退出
  })

  const wait = (ms: number): Promise<void> => Promise.race([sleep(ms), disposedPromise])

  return {
    /**
     * 后台连播 times 声；已有一轮在播时直接忽略。
     * @param sound 叫声音效。
     * @param times 播放次数。
     * @param gapMs 间隔毫秒。
     * @param maxMs 单声最长毫秒；0 = 不截断。
     */
    play(sound: Sound, times: number, gapMs: number, maxMs: number): void {
      if (running || disposed || !sound.ok || times <= 0) return
      running = true

      if (process.platform === 'win32') {
        // Windows 每次 spawn PowerShell 都有约 100 ms 冷启动，连播 10 声等于开
        // 10 个进程；改成在一个进程里循环播完，省掉 N-1 次进程创建。
        try {
          currentChild = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psPlayScript(sound.path, times, gapMs)], { stdio: 'ignore' })
          const done = (): void => { running = false; currentChild = null }
          currentChild.on('error', done)
          currentChild.once('exit', done)
          armKillTimer(currentChild, maxMs > 0 ? times * (maxMs + gapMs) : 0)
        } catch {
          running = false
          currentChild = null
        }
        return
      }

      void (async () => {
        try {
          for (let i = 0; i < times; i += 1) {
            if (disposed) return
            playFile(sound, maxMs)
            // 最后一声之后不再等待：原实现要多睡一个 gap 才收尾
            if (i < times - 1) await wait(gapMs)
          }
        } catch {
          /* 静默 */
        } finally {
          running = false
        }
      })()
    },

    /** 插件卸载 / 热重载：中断连播并清掉待触发的间隔定时器。 */
    dispose(): void {
      disposed = true
      if (timer) { clearTimeout(timer); timer = null }
      if (resolveDispose) { resolveDispose(); resolveDispose = null }
      if (currentChild) { currentChild.kill(); currentChild = null }
      running = false
    },
  }
}

export function apply(ctx: Context, rawConfig?: Partial<Config> | null): void {
  const config: Config = { ...DEFAULTS, ...(rawConfig ?? {}) }

  // 五个音效各解析 + stat 一次；此后热路径上再无任何文件系统调用。
  const commandSound = prepareSound(config.soundCommand, '命令')
  const questionSound = prepareSound(config.soundQuestion, '提问')
  const answerSound = prepareSound(config.soundAnswer, '回答确认')
  const readOutsideSound = prepareSound(config.soundReadOutside, '读工作区外')
  const barkSound = prepareSound(config.soundBark, '叫声')

  /**
   * 每 agent 的命令计数（按 agent.id 隔离；subagent 与主 agent 互不清零）。
   * key：agent?.id ?? '?' —— 没有 agent 归属的工具调用归入兜底键。
   * 放在 apply 作用域内：热重载即重置，且插件被装载两次时两个实例互不串扰。
   */
  const counts = new Map<string, number>()

  /** 叫声连播控制器；插件卸载时随 effect 一起中断。 */
  const barks = createBarkChain()
  ctx.effect(() => () => barks.dispose(), 'dsh-audio-dagou: bark chain')

  /**
   * 命令计数 +1，并把 Map 规模压在 MAX_TRACKED_AGENTS 以内。
   * @param key agent 标识。
   */
  function bump(key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (counts.size > MAX_TRACKED_AGENTS) {
      // Map 迭代按插入序：淘汰最旧的键（那些 agent 的回合早就结束了）
      const oldest = counts.keys().next()
      if (!oldest.done) counts.delete(oldest.value)
    }
  }

  /**
   * 观察每次工具执行的最终结果（observe-only，故障被包容）：
   * - bash 工具 → 该 agent 命令计数 +1（成功或失败都算“执行过命令”），并播「大狗」；
   * - ask_user_question 工具 → 播「诶」：`ask_user_question` 的工具体阻塞到用户
   *   作答才返回，所以 `tools/result` 在此刻触发 ==「用户刚回答完」，作为确认音；
   * - read 工具 → 若【读取成功】且目标文件在会话工作区之外，先播「叮咚鸡」（提问
   *   同款音效，即 `soundQuestion`）、再播「诶」（与回答确认音同款默认音效）：
   *   读到工作区外 = 一声像提问那样的提醒 + 一声确认。任一沙箱 mode 下读取都不
   *   受限，读到的内容可能来自工作区之外；判定口径与 read 工具自身一致（相对
   *   路径以会话 cwd 为基），仅在确实读到文件时触发（读失败、读到目录不算）。
   * 计数不受 enabled 影响（enabled=false 只静音仍计数），播放才被它门控。
   * 提问瞬间的音效不在这里播（那样它就晚到用户耳中），改由 `tools/execute` 播。
   */
  ctx.effect(() => ctx.on('tools/result', (exec, result) => {
    if (exec.name === BASH_TOOL) {
      bump(agentKey(exec.agent))
      if (config.enabled) playFile(commandSound)
      return
    }
    if (exec.name === ASK_USER_TOOL) {
      if (config.enabled) playFile(answerSound)
      return
    }
    if (exec.name === READ_TOOL && !result.isError) {
      // result.isError === false：read 已成功，目标路径是真实存在的常规文件。
      // exec.agent.session.header.cwd 是会话工作区（read 工具自己的解析根基），
      // 拿不到时跳过——宁可少响一次也不误报。
      const filePath = readRequestedFilePath(exec.arguments)
      const cwd = exec.agent?.session?.header?.cwd
      if (config.enabled && filePath !== null && cwd !== undefined && !isPathContained(cwd, filePath)) {
        // 「叮咚鸡」（提问音效）→「诶」（回答确认音），顺序播放避免两声混在一起；
        // 中间隔 150ms 让两声可分辨（连播在后台进行，不阻塞观察器）。
        playSequence([questionSound, readOutsideSound], 150)
      }
    }
  }), 'dsh-audio-dagou: observe tool results')

  /**
   * 提问瞬间播放提问音效（默认「叮咚鸡」）：`tools/execute` 是环绕分发层
   * （waterfall），触发时机为审批门禁放行之后、工具体即将运行之前——
   * `ask_user_question` 的工具体正是「弹出提问界面并阻塞等待用户回答」那一步，
   * 在此刻出声就是「提问时」。监听器只旁观 + 无条件转发 `next()`，不改变信号、
   * 不替换结果（around 语义安全）。
   */
  ctx.effect(() => ctx.on('tools/execute', (exec, next) => {
    if (config.enabled && exec.name === ASK_USER_TOOL) {
      playFile(questionSound)
    }
    return next()
  }), 'dsh-audio-dagou: sound on question asked')

  /**
   * 每轮任务结束边界（模型已给出最终回答、无未决工具调用）：
   * 只结算【该 agent 自己】的本轮命令计数，按比例连播「叫」（封顶 maxBarks），
   * 结算后删除该 agent 的计数（清零）——即使 enabled=false 也照常清零，
   * 避免禁用期间计数只进不清（「仍计数」语义）。监听器内不阻塞（连播在后台异步进行）。
   */
  ctx.effect(() => ctx.on('agent/turn-stopping', (payload: { agent: Agent }) => {
    const key = agentKey(payload.agent)
    const n = counts.get(key) ?? 0
    counts.delete(key)
    if (!config.enabled) return
    const times = Math.min(config.maxBarks, Math.round(n * config.barkScale))
    if (times <= 0) return
    barks.play(barkSound, times, config.barkGapMs, config.barkMaxMs)
  }), 'dsh-audio-dagou: turn-end barks')

  /**
   * 模型可调工具（官方 defineTool）：查询音效插件状态——命令计数、配置、音频就位情况。
   * 顺带作为“插件已生效”的探针，方便调试。
   */
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'audio_dagou_status',
    description: '查询「配音效(大狗)」插件状态：各 agent 本轮命令计数、配置（开关/倍数/上限/音频路径）、音频文件是否就位。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args: Record<string, never>, value: string) => [{ type: 'text', text: value }],
    },
    async execute(): Promise<string> {
      const player: string[] = []
      if (process.platform === 'darwin') player.push('afplay')
      else if (process.platform === 'win32') player.push('powershell')
      else player.push('paplay', 'pw-play', 'aplay')
      // installed 走实时 existsSync：冷路径，且要反映「现在」而非 apply 那一刻
      const live = (sound: Sound): string | null => (sound.path && existsSync(sound.path) ? sound.path : null)
      return JSON.stringify({
        ok: true,
        counts: Object.fromEntries(counts),
        installed: {
          bigDog: live(commandSound),
          eh: live(questionSound),
          answer: live(answerSound),
          readOutside: live(readOutsideSound),
          bark: live(barkSound),
        },
        config: {
          enabled: config.enabled,
          barkScale: config.barkScale,
          maxBarks: config.maxBarks,
          barkGapMs: config.barkGapMs,
          barkMaxMs: config.barkMaxMs,
          soundCommand: config.soundCommand,
          soundQuestion: config.soundQuestion,
          soundAnswer: config.soundAnswer,
          soundReadOutside: config.soundReadOutside,
          soundBark: config.soundBark,
        },
        player,
      })
    },
  })), 'dsh-audio-dagou: status tool')
}
