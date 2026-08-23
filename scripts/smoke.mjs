/**
 * dsh-audio-dagou 冒烟测试（三平台通用，无第三方依赖）。
 *
 * 覆盖：
 *   1. lib 模块加载与 Cordis 插件形态（name/inject/apply/Config）
 *   2. apply 事件接线（tools/execute、tools/result、agent/turn-stopping）与工具注册
 *   3. bash 计数、ask_user_question 提问瞬间转发、按 agent 隔离、turn 结束清零
 *   4. 三平台播放器映射（darwin→afplay / win32→powershell / linux→paplay|pw-play|aplay）
 *   5. 内置音频资产（中文文件名）真实存在
 *
 * 声音路径故意指向不存在的文件，避免 CI 里真的出声；计数逻辑照常全量执行。
 * 断言失败时以非零码退出。
 */
import { existsSync } from 'node:fs'
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

if (failed > 0) {
  console.error(`\nSMOKE FAILED: ${failed} 项失败`)
  process.exit(1)
}
console.log('\nSMOKE OK — 全部通过（平台: ' + process.platform + '）')
