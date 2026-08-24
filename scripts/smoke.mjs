/**
 * dsh-audio-dagou 冒烟测试（三平台通用，无第三方依赖）。
 *
 * 覆盖：
 *   1. lib 模块加载与 Cordis 插件形态（name/inject/apply/Config）
 *   2. apply 事件接线（tools/execute、tools/result、approval/request、
 *      agent/turn-stopping）与工具注册
 *   3. bash 计数、ask_user_question 提问瞬间转发、按 agent 隔离、turn 结束清零
 *   4. 三平台播放器映射（darwin→afplay / win32→powershell / linux→paplay|pw-play|aplay）
 *   5. 内置音频资产（中文文件名）真实存在
 *   6. 读工作区外判定（isPathContained：越界 / 前缀误判 / symlink 别名 / 大小写；
 *      isWorkspacePath：cwd ∪ workspaceRoots 合并判定）与 read 结果分支的
 *      健壮性（缺字段不崩、不计入 bash 计数）
 *
 * 声音路径故意指向不存在的文件，避免 CI 里真的出声；计数逻辑照常全量执行。
 * 断言失败时以非零码退出。
 */
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

let failed = 0
function check(label, cond) {
  if (cond) {
    console.log('  ✓', label)
  } else {
    console.error('  ✗', label)
    failed++
  }
}

const libUrl = new URL('../lib/index.js', import.meta.url)
const P = await import(libUrl)

console.log('[1] 模块加载 / 插件形态')
check('name = dsh-audio-dagou', P.name === 'dsh-audio-dagou')
check('inject 包含 tools', Array.isArray(P.inject) && P.inject.includes('tools'))
check('apply 是函数', typeof P.apply === 'function')
check('Config 是 schema', typeof P.Config === 'function')

// —— 事件桩 + 工具捕获 ——
const handlers = {}
let registeredTool = null
const ctx = {
  effect: (fn) => fn(),
  on: (ev, h) => { handlers[ev] = h; return () => {} },
  tools: { register: (d) => { registeredTool = d } },
}

// 不存在的音效路径：仍走完整计数逻辑，但 playFile 会静默跳过（不真正出声）
P.apply(ctx, {
  soundCommand: '/__nonexistent__/大狗.wav',
  soundQuestion: '/__nonexistent__/诶.wav',
  soundBark: '/__nonexistent__/叫.wav',
})

console.log('[2] 事件接线 / 工具注册')
check('tools/execute 监听已挂（提问瞬间）', typeof handlers['tools/execute'] === 'function')
check('tools/result 监听已挂', typeof handlers['tools/result'] === 'function')
check('approval/request 监听已挂（放权请求）', typeof handlers['approval/request'] === 'function')
check('agent/turn-stopping 监听已挂', typeof handlers['agent/turn-stopping'] === 'function')
check('audio_dagou_status 工具已注册', !!registeredTool && registeredTool.name === 'audio_dagou_status')

const status = async () => JSON.parse(await registeredTool.execute({}))

console.log('[3] 计数逻辑（按 agent 隔离）')
const main = { id: 'main-agent' }, sub = { id: 'sub-1' }
for (let i = 0; i < 4; i++) handlers['tools/result']({ name: 'bash', agent: main, token: Symbol() }, { isError: false })
for (let i = 0; i < 2; i++) handlers['tools/result']({ name: 'bash', agent: sub, token: Symbol() }, { isError: false })

// 提问瞬间：tools/execute 环绕层必须无条件转发 next() 的结果（around 语义安全）
const execRes = await handlers['tools/execute'](
  { name: 'ask_user_question', agent: main, signal: new AbortController().signal },
  async () => ({ isError: false, content: [] }),
)
check('tools/execute 转发 next() 结果', execRes && execRes.isError === false)

// 放权请求：approval/request 环绕层必须无条件转发决议（allowed-once 原样放行）
const approvalRes = await handlers['approval/request'](
  { agent: main, toolName: 'write', signal: new AbortController().signal },
  async () => 'allowed-once',
)
check('approval/request 转发允许决议', approvalRes === 'allowed-once')

// ask_user_question 走完流水线后 tools/result 也会触发：不得被计入 bash 计数
handlers['tools/result']({ name: 'ask_user_question', agent: main, token: Symbol() }, { isError: false })

let s = await status()
check('主4+子2 计数隔离', s.counts['main-agent'] === 4 && s.counts['sub-1'] === 2)

handlers['agent/turn-stopping']({ agent: sub, turn: 1, signal: new AbortController().signal })
await new Promise((r) => setTimeout(r, 30))
s = await status()
check('subagent 回合只清零自己', s.counts['main-agent'] === 4 && s.counts['sub-1'] === undefined)

handlers['agent/turn-stopping']({ agent: main, turn: 1, signal: new AbortController().signal })
await new Promise((r) => setTimeout(r, 30))
s = await status()
check('主 agent 回合后全清零', Object.keys(s.counts).length === 0)

console.log('[3b] 禁用态仍计数（enabled=false 只静音，不停止计数/清零）')
let t2 = null
P.apply({
  effect: (fn) => fn(),
  on: (ev, h) => { handlers[ev] = h; return () => {} },
  tools: { register: (d) => { t2 = d } },
}, {
  enabled: false,
  soundCommand: '/__nonexistent__/大狗.wav',
  soundQuestion: '/__nonexistent__/叮咚鸡.wav',
  soundAnswer: '/__nonexistent__/诶.wav',
  soundBark: '/__nonexistent__/叫.wav',
})
const status2 = async () => JSON.parse(await t2.execute({}))
handlers['tools/result']({ name: 'bash', agent: { id: 'quiet-agent' }, token: Symbol() }, { isError: false })
let s2 = await status2()
check('禁用时命令仍计数', s2.counts['quiet-agent'] === 1)
handlers['agent/turn-stopping']({ agent: { id: 'quiet-agent' }, turn: 1, signal: new AbortController().signal })
await new Promise((r) => setTimeout(r, 30))
s2 = await status2()
check('禁用时回合结束仍清零', Object.keys(s2.counts).length === 0)

console.log('[4] 三平台播放器映射')
const expected = process.platform === 'darwin' ? ['afplay']
  : process.platform === 'win32' ? ['powershell']
  : ['paplay', 'pw-play', 'aplay']
check(`platform=${process.platform} → ${JSON.stringify(expected)}`, JSON.stringify(s.player) === JSON.stringify(expected))

console.log('[5] 内置资产就位（中文文件名）')
const assetsDir = new URL('../assets/', import.meta.url)
for (const f of ['大狗.wav', '叮咚鸡.wav', '诶.wav', '叫.wav']) {
  const p = fileURLToPath(new URL(f, assetsDir))
  check(`assets/${f} 存在`, existsSync(p))
}

console.log('[6] 读工作区外判定（isPathContained）')
const repo = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = repo.replace(/[\\/]+$/, '') // 去掉尾部分隔符，便于构造兄弟目录
check('相对路径在工作区内', P.isPathContained(repo, 'src/index.ts') === true)
check('绝对路径在工作区内', P.isPathContained(repo, fileURLToPath(new URL('lib/index.js', import.meta.url))) === true)
check('上层目录越界', P.isPathContained(repo, '../dsh-audio-dagou-elsewhere/x.txt') === false)
check('前缀相似的兄弟目录不算包含', P.isPathContained(repoRoot, repoRoot + '2/x.txt') === false)

// workspaceRoots 合并判定：cwd ∪ 额外根 之内才算工作区
check('isWorkspacePath：cwd 内算工作区', P.isWorkspacePath(repoRoot, 'src/index.ts', []) === true)
check('isWorkspacePath：额外根内也算工作区', P.isWorkspacePath('/x/ws', '/x/proj/README.md', ['/x/proj']) === true)
check('isWorkspacePath：都不在才算非工作区', P.isWorkspacePath('/x/ws', '/x/outside/secret.txt', ['/x/proj']) === false)
check('isWorkspacePath：无 cwd 时按额外根判定', P.isWorkspacePath(undefined, '/x/proj/a.ts', ['/x/proj']) === true)
check('isWorkspacePath：无 cwd 且无额外根则不判为工作区', P.isWorkspacePath(undefined, '/x/proj/a.ts', []) === false)
if (process.platform === 'win32') {
  check('win32 忽略大小写', P.isPathContained('C:\\WS\\Repo', 'c:\\ws\\repo\\src\\a.ts') === true)
}

const tReal = mkdtempSync(join(tmpdir(), 'dagou-ws-'))
const tAlias = join(tmpdir(), `dagou-alias-${randomUUID()}`)
let tmpFiles = [tReal]
try {
  writeFileSync(join(tReal, 'inside.txt'), 'x')
  symlinkSync(tReal, tAlias)
  tmpFiles.push(tAlias)
  // 工作区根本身是 symlink（macOS /tmp → /private/tmp 场景）：真实路径拼写仍算在内
  check('工作区为 symlink 别名：真实路径目标仍算在内', P.isPathContained(tAlias, join(tReal, 'inside.txt')) === true)
  // 工作区内 symlink 指向工作区外：读到的内容来自外面 → 算越界
  const outside = join(tmpdir(), `dagou-out-${randomUUID()}.txt`)
  writeFileSync(outside, 'x')
  tmpFiles.push(outside)
  symlinkSync(outside, join(tReal, 'leak.txt'))
  check('工作区内 symlink 指向外部文件算越界', P.isPathContained(tReal, join(tReal, 'leak.txt')) === false)
} catch (error) {
  console.log('  - 跳过 symlink 用例（当前平台不允许创建符号链接）:', error.message)
} finally {
  for (const f of tmpFiles) {
    try { rmSync(f, { recursive: true, force: true }) } catch { /* 清理失败不影响结果 */ }
  }
}

// read 结果分支健壮性：缺字段 / 非字符串 file_path / 无 cwd（且无 workspaceRoots）
// 都不崩、也不计入 bash 计数；「边界不可知」须由分支的 workspaceKnown 门控兜住。
let threw = false
try {
  handlers['tools/result']({ name: 'read', agent: { id: 'r1' }, arguments: { file_path: 42 } }, { isError: false })
  handlers['tools/result']({ name: 'read', agent: { id: 'r2' } }, { isError: false })
  handlers['tools/result']({ name: 'read', agent: { id: 'r3' }, arguments: { file_path: '../outside.txt' } }, { isError: true })
  // 有效 file_path + 无 session（cwd 缺失）+ 本实例无 workspaceRoots：不崩（且按
  // 门控不触发播放——边界不可知宁可少响，行为由 isWorkspacePath/workspaceKnown 保证）
  handlers['tools/result']({ name: 'read', agent: { id: 'r4' }, arguments: { file_path: '/etc/hosts' } }, { isError: false })
} catch (e) {
  threw = true
  console.error('  read 结果分支抛异常:', e)
}
check('read 结果分支不抛异常', threw === false)
const s6 = await status2()
check('read 不计入命令计数', s6.counts['r1'] === undefined && s6.counts['r2'] === undefined && s6.counts['r3'] === undefined && s6.counts['r4'] === undefined)

if (failed > 0) {
  console.error(`\nSMOKE FAILED: ${failed} 项失败`)
  process.exit(1)
}
console.log('\nSMOKE OK — 全部通过（平台: ' + process.platform + '）')
