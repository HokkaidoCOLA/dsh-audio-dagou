/**
 * dsh-audio-dagou — 给 DeepSeek Harness（DSH）会话配音效的宿主插件。
 *
 * 行为（用户需求）：
 *   1. 模型每执行一条命令（`bash` 工具调用）后 → 播放「大狗.wav」，并把命令计数 +1；
 *   2. 模型向用户提问（`ask_user_question` 工具调用）时 → 播放「诶.wav」；
 *   3. 每一轮用户请求（一个 agent turn）结束时 → 按本轮命令计数成正比地播放
 *      「叫.wav」，播放次数 = min(round(计数 × barkScale), maxBarks)（默认最多 10 声），
 *      随后把该 agent 的计数清零。
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
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-audio-dagou'
export const inject = ['tools']

/** 模型执行命令的工具名（dsh-tool-bash 注册）。 */
const BASH_TOOL = 'bash'
/** 模型向用户提问的工具名（dsh-tool-ask-user 注册）。 */
const ASK_USER_TOOL = 'ask_user_question'

/** 插件自带音频资产目录（lib/../assets）。 */
const ASSETS_DIR = fileURLToPath(new URL('../assets/', import.meta.url))

export interface Config {
  /** 总开关：false 时全部静音（仍计数）。 */
  enabled: boolean
  /** 每执行一条命令后播放的音效。内置：`大狗.wav`；或填任意绝对路径。 */
  soundCommand: string
  /** 模型提问时播放的音效。内置：`诶.wav`；或填任意绝对路径。 */
  soundQuestion: string
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
  soundQuestion: Schema.string().default('诶.wav'),
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
  soundQuestion: '诶.wav',
  soundBark: '叫.wav',
  barkScale: 1,
  maxBarks: 10,
  barkGapMs: 420,
  barkMaxMs: 0,
}

/**
 * 每 agent 的命令计数（按 agent.id 隔离；subagent 与主 agent 互不清零）。
 * key：agent?.id ?? '?' —— 没有 agent 归属的工具调用归入兜底键。
 * 放模块级便于跨事件共享；每轮 turn-stopping 结束后该键即被删除。
 */
const counts = new Map<string, number>()

/** 是否已有一轮「叫」的连播在进行（防御并发 turn-stopping 重复触发）。 */
let barkChainRunning = false

/** 从 agent 对象取稳定 id；缺省回退 '?'。 */
function agentKey(agent: { id?: string } | null | undefined): string {
  return agent?.id ?? '?'
}

/** 解析音效配置：内置文件名 → 插件资产绝对路径；其余（绝对路径）原样使用。 */
function resolveSound(spec: string): string {
  if (!spec) return ''
  if (spec === '大狗.wav' || spec === '诶.wav' || spec === '叫.wav') {
    return fileURLToPath(new URL(`../assets/${spec}`, import.meta.url))
  }
  return spec
}

/**
 * 播放一个音频文件：fire-and-forget、绝不抛错。
 * - darwin → afplay
 * - win32  → PowerShell SoundPlayer（System.Media.SoundPlayer）
 * - linux  → paplay（无则 pw-play，无则 aplay）
 * 找不到文件 / 播放器缺失 / 播放失败都静默吞掉，保证不影响宿主流程。
 * @param file 音频文件绝对路径。
 * @param maxMs 播放超过该时长强制停止；0 = 不截断。
 */
function playFile(file: string, maxMs = 0): void {
  if (!file) return
  if (!existsSync(file)) {
    console.warn(`[dsh-audio-dagou] 音效文件不存在，跳过播放：${file}`)
    return
  }
  try {
    if (process.platform === 'darwin') {
      const child = spawn('afplay', [file], { stdio: 'ignore' })
      child.on('error', () => { /* 播放器缺失等，静默 */ })
      if (maxMs > 0) setTimeout(() => child.kill(), maxMs)
      return
    }
    if (process.platform === 'win32') {
      // 全限定类型名：PowerShell 无法解析未带 System. 前缀的 Media.SoundPlayer
      const script = `(New-Object System.Media.SoundPlayer '${file.replaceAll("'", "''")}').PlaySync();`
      const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' })
      child.on('error', () => { /* 静默 */ })
      return
    }
    // linux：优先 PulseAudio → PipeWire → ALSA。
    const names = ['paplay', 'pw-play', 'aplay']
    const tryPlayer = (index: number): void => {
      if (index >= names.length) return
      const child = spawn(names[index], [file], { stdio: 'ignore' })
      child.on('error', () => tryPlayer(index + 1))
    }
    tryPlayer(0)
  } catch {
    /* 任何播放异常都不向外抛 */
  }
}

/** 后台连播 n 声「叫」，间隔 gapMs；fire-and-forget（对外节流，防止重复触发）。 */
function playBarks(assetPath: string, times: number, gapMs: number, maxMs: number): void {
  if (barkChainRunning) return
  barkChainRunning = true
  void (async () => {
    try {
      for (let i = 0; i < times; i++) {
        playFile(assetPath, maxMs)
        await new Promise((resolve) => setTimeout(resolve, gapMs))
      }
    } catch {
      /* 静默 */
    } finally {
      barkChainRunning = false
    }
  })()
}

export function apply(ctx: Context, rawConfig?: Partial<Config> | null): void {
  const config: Config = { ...DEFAULTS, ...(rawConfig ?? {}) }

  const commandSound = resolveSound(config.soundCommand)
  const questionSound = resolveSound(config.soundQuestion)
  const barkSound = resolveSound(config.soundBark)

  /**
   * 观察每次工具执行的最终结果（observe-only，故障被包容）：
   * - bash 工具 → 该 agent 命令计数 +1（成功或失败都算“执行过命令”），并播「大狗」；
   * - ask_user_question 工具 → 播「诶」。
   */
  ctx.effect(() => ctx.on('tools/result', (exec) => {
    if (!config.enabled) return
    if (exec.name === BASH_TOOL) {
      const key = agentKey(exec.agent)
      counts.set(key, (counts.get(key) ?? 0) + 1)
      playFile(commandSound)
    } else if (exec.name === ASK_USER_TOOL) {
      playFile(questionSound)
    }
  }), 'dsh-audio-dagou: observe tool results')

  /**
   * 每轮任务结束边界（模型已给出最终回答、无未决工具调用）：
   * 只结算【该 agent 自己】的本轮命令计数，按比例连播「叫」（封顶 maxBarks），
   * 结算后删除该 agent 的计数（清零）。监听器内不阻塞（连播改后台异步）。
   */
  ctx.effect(() => ctx.on('agent/turn-stopping', (payload: { agent: Agent }) => {
    if (!config.enabled) return
    const key = agentKey(payload.agent)
    const n = counts.get(key) ?? 0
    counts.delete(key)
    const times = Math.min(config.maxBarks, Math.round(n * config.barkScale))
    if (times <= 0) return
    playBarks(barkSound, times, config.barkGapMs, config.barkMaxMs)
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
      return JSON.stringify({
        ok: true,
        counts: Object.fromEntries(counts),
        installed: {
          bigDog: existsSync(commandSound) ? commandSound : null,
          eh: existsSync(questionSound) ? questionSound : null,
          bark: existsSync(barkSound) ? barkSound : null,
        },
        config: {
          enabled: config.enabled,
          barkScale: config.barkScale,
          maxBarks: config.maxBarks,
          barkGapMs: config.barkGapMs,
          barkMaxMs: config.barkMaxMs,
          soundCommand: config.soundCommand,
          soundQuestion: config.soundQuestion,
          soundBark: config.soundBark,
        },
        player,
      })
    },
  })), 'dsh-audio-dagou: status tool')

  // 仅用于模块完整性（host 无客户端注入）。保留 ASSETS_DIR 常量以防误删被引用。
  void ASSETS_DIR
}
