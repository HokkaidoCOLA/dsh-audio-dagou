import { defineTool } from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const name = 'dsh-audio-dagou';
export const inject = ['tools'];
/** 模型执行命令的工具名（dsh-tool-bash 注册）。 */
const BASH_TOOL = 'bash';
/** 模型向用户提问的工具名（dsh-tool-ask-user 注册）。 */
const ASK_USER_TOOL = 'ask_user_question';
/** 插件自带音频资产目录（lib/../assets）。 */
const ASSETS_DIR = fileURLToPath(new URL('../assets/', import.meta.url));
/** 内置音效文件名：填这些名字即用插件自带资产，其余按路径处理。 */
const BUILTIN_SOUNDS = new Set(['大狗.wav', '叮咚鸡.wav', '诶.wav', '叫.wav']);
/**
 * 每 agent 命令计数的保留上限。
 *
 * 正常情况下每个 key 都会在 `agent/turn-stopping` 时被删除；但被强制中断、
 * 崩溃、或根本没走到 turn 边界的 agent 会留下孤儿键。长期运行的 host 里每个
 * subagent 的 id 都不同，不设上限则该 Map 会无界增长——超限时按插入序淘汰最旧的。
 */
const MAX_TRACKED_AGENTS = 256;
/** 配置声明：loader 在挂载前校验入口 config 并填入默认值。 */
export const Config = Schema.object({
    enabled: Schema.boolean().default(true),
    soundCommand: Schema.string().default('大狗.wav'),
    soundQuestion: Schema.string().default('叮咚鸡.wav'),
    soundAnswer: Schema.string().default('诶.wav'),
    soundBark: Schema.string().default('叫.wav'),
    barkScale: Schema.number().min(0).step(0.1).default(1),
    maxBarks: Schema.number().min(1).max(100).step(1).default(10),
    barkGapMs: Schema.number().min(0).step(1).default(420),
    barkMaxMs: Schema.number().min(0).step(1).default(0),
});
/** 配置默认值（与 Config schema 的 default 一致；直接调用 apply 时兜底）。 */
const DEFAULTS = {
    enabled: true,
    soundCommand: '大狗.wav',
    soundQuestion: '叮咚鸡.wav',
    soundAnswer: '诶.wav',
    soundBark: '叫.wav',
    barkScale: 1,
    maxBarks: 10,
    barkGapMs: 420,
    barkMaxMs: 0,
};
/** 从 agent 对象取稳定 id；缺省回退 '?'。 */
function agentKey(agent) {
    return agent?.id ?? '?';
}
/** 解析音效配置：内置文件名 → 插件资产绝对路径；其余（绝对路径）原样使用。 */
function resolveSound(spec) {
    if (!spec)
        return '';
    return BUILTIN_SOUNDS.has(spec) ? join(ASSETS_DIR, spec) : spec;
}
/** 解析并校验一个音效（同步 stat 全程只做这一次），缺失时只警告一次。 */
function prepareSound(spec, label) {
    const path = resolveSound(spec);
    if (!path)
        return { path: '', ok: false };
    const ok = existsSync(path);
    if (!ok)
        console.warn(`[dsh-audio-dagou] ${label}音效文件不存在，相关播放将跳过：${path}`);
    return { path, ok };
}
/**
 * 给播放进程挂一个「最长播放时长」看门狗。
 * 子进程先自然退出就撤掉定时器；定时器 unref，避免一个待触发的 kill 把 host
 * 的退出硬拖 maxMs。
 * @param child 播放子进程。
 * @param maxMs 超时强杀毫秒数；<=0 表示不截断。
 */
function armKillTimer(child, maxMs) {
    if (maxMs <= 0)
        return;
    const timer = setTimeout(() => child.kill(), maxMs);
    timer.unref?.();
    child.once('exit', () => clearTimeout(timer));
}
/**
 * 生成 Windows 播放脚本：一个 PowerShell 进程内播 times 声。
 * @param file 音频绝对路径。
 * @param times 播放次数。
 * @param gapMs 两声之间间隔（最后一声之后不等待）。
 * @returns PowerShell 命令串。
 */
function psPlayScript(file, times, gapMs) {
    // 全限定类型名：PowerShell 无法解析未带 System. 前缀的 Media.SoundPlayer
    const player = `$p = New-Object System.Media.SoundPlayer '${file.replaceAll("'", "''")}';`;
    if (times <= 1)
        return `${player} $p.PlaySync();`;
    const gap = gapMs > 0
        ? ` if ($i -lt ${times - 1}) { Start-Sleep -Milliseconds ${Math.round(gapMs)} };`
        : '';
    return `${player} for ($i = 0; $i -lt ${times}; $i++) { $p.PlaySync();${gap} }`;
}
/**
 * 播放一个音频文件：fire-and-forget、绝不抛错。
 * - darwin → afplay
 * - win32  → PowerShell SoundPlayer（System.Media.SoundPlayer）
 * - linux  → paplay（无则 pw-play，无则 aplay）
 * 播放器缺失 / 播放失败都静默吞掉，保证不影响宿主流程。
 * @param sound 已校验的音效。
 * @param maxMs 播放超过该时长强制停止；0 = 不截断。
 */
function playFile(sound, maxMs = 0) {
    if (!sound.ok)
        return;
    const file = sound.path;
    try {
        if (process.platform === 'darwin') {
            const child = spawn('afplay', [file], { stdio: 'ignore' });
            child.on('error', () => { });
            armKillTimer(child, maxMs);
            return;
        }
        if (process.platform === 'win32') {
            const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psPlayScript(file, 1, 0)], { stdio: 'ignore' });
            child.on('error', () => { });
            armKillTimer(child, maxMs);
            return;
        }
        // linux：优先 PulseAudio → PipeWire → ALSA。
        const names = ['paplay', 'pw-play', 'aplay'];
        const tryPlayer = (index) => {
            if (index >= names.length)
                return;
            const child = spawn(names[index], [file], { stdio: 'ignore' });
            child.on('error', () => tryPlayer(index + 1));
            armKillTimer(child, maxMs);
        };
        tryPlayer(0);
    }
    catch {
        /* 任何播放异常都不向外抛 */
    }
}
/**
 * 「叫」的连播控制器（每个 apply 一个实例）。
 *
 * 连播在后台进行，绝不阻塞 `agent/turn-stopping`（那是个串行且被 await 的边界）；
 * 同一时刻只允许一轮，避免主 agent 与 subagent 的回合叠成噪音。
 * @returns 控制器：play 发起连播，dispose 在热重载/卸载时中断。
 */
function createBarkChain() {
    let running = false;
    let disposed = false;
    let timer = null;
    let currentChild = null;
    let resolveDispose = null;
    // 一旦 dispose 即 resolve：让「挂在 sleep 上的循环」立即醒过来退出，
    // 否则被清除的定时器会让该 Promise 永不 settle，异步循环永久悬挂。
    const disposedPromise = new Promise((resolve) => { resolveDispose = resolve; });
    /** 可被 dispose 打断的等待。 */
    const sleep = (ms) => new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref?.(); // 待触发的间隔不该拖住 host 退出
    });
    const wait = (ms) => Promise.race([sleep(ms), disposedPromise]);
    return {
        /**
         * 后台连播 times 声；已有一轮在播时直接忽略。
         * @param sound 叫声音效。
         * @param times 播放次数。
         * @param gapMs 间隔毫秒。
         * @param maxMs 单声最长毫秒；0 = 不截断。
         */
        play(sound, times, gapMs, maxMs) {
            if (running || disposed || !sound.ok || times <= 0)
                return;
            running = true;
            if (process.platform === 'win32') {
                // Windows 每次 spawn PowerShell 都有约 100 ms 冷启动，连播 10 声等于开
                // 10 个进程；改成在一个进程里循环播完，省掉 N-1 次进程创建。
                try {
                    currentChild = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psPlayScript(sound.path, times, gapMs)], { stdio: 'ignore' });
                    const done = () => { running = false; currentChild = null; };
                    currentChild.on('error', done);
                    currentChild.once('exit', done);
                    armKillTimer(currentChild, maxMs > 0 ? times * (maxMs + gapMs) : 0);
                }
                catch {
                    running = false;
                    currentChild = null;
                }
                return;
            }
            void (async () => {
                try {
                    for (let i = 0; i < times; i += 1) {
                        if (disposed)
                            return;
                        playFile(sound, maxMs);
                        // 最后一声之后不再等待：原实现要多睡一个 gap 才收尾
                        if (i < times - 1)
                            await wait(gapMs);
                    }
                }
                catch {
                    /* 静默 */
                }
                finally {
                    running = false;
                }
            })();
        },
        /** 插件卸载 / 热重载：中断连播并清掉待触发的间隔定时器。 */
        dispose() {
            disposed = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (resolveDispose) {
                resolveDispose();
                resolveDispose = null;
            }
            if (currentChild) {
                currentChild.kill();
                currentChild = null;
            }
            running = false;
        },
    };
}
export function apply(ctx, rawConfig) {
    const config = { ...DEFAULTS, ...(rawConfig ?? {}) };
    // 四个音效各解析 + stat 一次；此后热路径上再无任何文件系统调用。
    const commandSound = prepareSound(config.soundCommand, '命令');
    const questionSound = prepareSound(config.soundQuestion, '提问');
    const answerSound = prepareSound(config.soundAnswer, '回答确认');
    const barkSound = prepareSound(config.soundBark, '叫声');
    /**
     * 每 agent 的命令计数（按 agent.id 隔离；subagent 与主 agent 互不清零）。
     * key：agent?.id ?? '?' —— 没有 agent 归属的工具调用归入兜底键。
     * 放在 apply 作用域内：热重载即重置，且插件被装载两次时两个实例互不串扰。
     */
    const counts = new Map();
    /** 叫声连播控制器；插件卸载时随 effect 一起中断。 */
    const barks = createBarkChain();
    ctx.effect(() => () => barks.dispose(), 'dsh-audio-dagou: bark chain');
    /**
     * 命令计数 +1，并把 Map 规模压在 MAX_TRACKED_AGENTS 以内。
     * @param key agent 标识。
     */
    function bump(key) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (counts.size > MAX_TRACKED_AGENTS) {
            // Map 迭代按插入序：淘汰最旧的键（那些 agent 的回合早就结束了）
            const oldest = counts.keys().next();
            if (!oldest.done)
                counts.delete(oldest.value);
        }
    }
    /**
     * 观察每次工具执行的最终结果（observe-only，故障被包容）：
     * - bash 工具 → 该 agent 命令计数 +1（成功或失败都算“执行过命令”），并播「大狗」；
     * - ask_user_question 工具 → 播「诶」：`ask_user_question` 的工具体阻塞到用户
     *   作答才返回，所以 `tools/result` 在此刻触发 ==「用户刚回答完」，作为确认音。
     * 计数不受 enabled 影响（enabled=false 只静音仍计数），播放才被它门控。
     * 提问瞬间的音效不在这里播（那样它就晚到用户耳中），改由 `tools/execute` 播。
     */
    ctx.effect(() => ctx.on('tools/result', (exec) => {
        if (exec.name === BASH_TOOL) {
            bump(agentKey(exec.agent));
            if (config.enabled)
                playFile(commandSound);
        }
        else if (exec.name === ASK_USER_TOOL) {
            if (config.enabled)
                playFile(answerSound);
        }
    }), 'dsh-audio-dagou: observe tool results');
    /**
     * 提问瞬间播放提问音效（默认「叮咚鸡」）：`tools/execute` 是环绕分发层
     * （waterfall），触发时机为审批门禁放行之后、工具体即将运行之前——
     * `ask_user_question` 的工具体正是「弹出提问界面并阻塞等待用户回答」那一步，
     * 在此刻出声就是「提问时」。监听器只旁观 + 无条件转发 `next()`，不改变信号、
     * 不替换结果（around 语义安全）。
     */
    ctx.effect(() => ctx.on('tools/execute', (exec, next) => {
        if (config.enabled && exec.name === ASK_USER_TOOL) {
            playFile(questionSound);
        }
        return next();
    }), 'dsh-audio-dagou: sound on question asked');
    /**
     * 每轮任务结束边界（模型已给出最终回答、无未决工具调用）：
     * 只结算【该 agent 自己】的本轮命令计数，按比例连播「叫」（封顶 maxBarks），
     * 结算后删除该 agent 的计数（清零）——即使 enabled=false 也照常清零，
     * 避免禁用期间计数只进不清（「仍计数」语义）。监听器内不阻塞（连播在后台异步进行）。
     */
    ctx.effect(() => ctx.on('agent/turn-stopping', (payload) => {
        const key = agentKey(payload.agent);
        const n = counts.get(key) ?? 0;
        counts.delete(key);
        if (!config.enabled)
            return;
        const times = Math.min(config.maxBarks, Math.round(n * config.barkScale));
        if (times <= 0)
            return;
        barks.play(barkSound, times, config.barkGapMs, config.barkMaxMs);
    }), 'dsh-audio-dagou: turn-end barks');
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
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute() {
            const player = [];
            if (process.platform === 'darwin')
                player.push('afplay');
            else if (process.platform === 'win32')
                player.push('powershell');
            else
                player.push('paplay', 'pw-play', 'aplay');
            // installed 走实时 existsSync：冷路径，且要反映「现在」而非 apply 那一刻
            const live = (sound) => (sound.path && existsSync(sound.path) ? sound.path : null);
            return JSON.stringify({
                ok: true,
                counts: Object.fromEntries(counts),
                installed: {
                    bigDog: live(commandSound),
                    eh: live(questionSound),
                    answer: live(answerSound),
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
                    soundBark: config.soundBark,
                },
                player,
            });
        },
    })), 'dsh-audio-dagou: status tool');
}
//# sourceMappingURL=index.js.map