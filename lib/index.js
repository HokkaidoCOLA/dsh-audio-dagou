import { defineTool } from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const name = 'dsh-audio-dagou';
export const inject = ['tools'];
/** 模型执行命令的工具名（dsh-tool-bash 注册）。 */
const BASH_TOOL = 'bash';
/** 模型向用户提问的工具名（dsh-tool-ask-user 注册）。 */
const ASK_USER_TOOL = 'ask_user_question';
/** 插件自带音频资产目录（lib/../assets）。 */
const ASSETS_DIR = fileURLToPath(new URL('../assets/', import.meta.url));
/** 配置声明：loader 在挂载前校验入口 config 并填入默认值。 */
export const Config = Schema.object({
    enabled: Schema.boolean().default(true),
    soundCommand: Schema.string().default('大狗.wav'),
    soundQuestion: Schema.string().default('诶.wav'),
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
    soundQuestion: '诶.wav',
    soundBark: '叫.wav',
    barkScale: 1,
    maxBarks: 10,
    barkGapMs: 420,
    barkMaxMs: 0,
};
/**
 * 每 agent 的命令计数（按 agent.id 隔离；subagent 与主 agent 互不清零）。
 * key：agent?.id ?? '?' —— 没有 agent 归属的工具调用归入兜底键。
 * 放模块级便于跨事件共享；每轮 turn-stopping 结束后该键即被删除。
 */
const counts = new Map();
/** 是否已有一轮「叫」的连播在进行（防御并发 turn-stopping 重复触发）。 */
let barkChainRunning = false;
/** 从 agent 对象取稳定 id；缺省回退 '?'。 */
function agentKey(agent) {
    return agent?.id ?? '?';
}
/** 解析音效配置：内置文件名 → 插件资产绝对路径；其余（绝对路径）原样使用。 */
function resolveSound(spec) {
    if (!spec)
        return '';
    if (spec === '大狗.wav' || spec === '诶.wav' || spec === '叫.wav') {
        return fileURLToPath(new URL(`../assets/${spec}`, import.meta.url));
    }
    return spec;
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
function playFile(file, maxMs = 0) {
    if (!file)
        return;
    if (!existsSync(file)) {
        console.warn(`[dsh-audio-dagou] 音效文件不存在，跳过播放：${file}`);
        return;
    }
    try {
        if (process.platform === 'darwin') {
            const child = spawn('afplay', [file], { stdio: 'ignore' });
            child.on('error', () => { });
            if (maxMs > 0)
                setTimeout(() => child.kill(), maxMs);
            return;
        }
        if (process.platform === 'win32') {
            // 全限定类型名：PowerShell 无法解析未带 System. 前缀的 Media.SoundPlayer
            const script = `(New-Object System.Media.SoundPlayer '${file.replaceAll("'", "''")}').PlaySync();`;
            const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
            child.on('error', () => { });
            return;
        }
        // linux：优先 PulseAudio → PipeWire → ALSA。
        const names = ['paplay', 'pw-play', 'aplay'];
        const tryPlayer = (index) => {
            if (index >= names.length)
                return;
            const child = spawn(names[index], [file], { stdio: 'ignore' });
            child.on('error', () => tryPlayer(index + 1));
        };
        tryPlayer(0);
    }
    catch {
        /* 任何播放异常都不向外抛 */
    }
}
/** 后台连播 n 声「叫」，间隔 gapMs；fire-and-forget（对外节流，防止重复触发）。 */
function playBarks(assetPath, times, gapMs, maxMs) {
    if (barkChainRunning)
        return;
    barkChainRunning = true;
    void (async () => {
        try {
            for (let i = 0; i < times; i++) {
                playFile(assetPath, maxMs);
                await new Promise((resolve) => setTimeout(resolve, gapMs));
            }
        }
        catch {
            /* 静默 */
        }
        finally {
            barkChainRunning = false;
        }
    })();
}
export function apply(ctx, rawConfig) {
    const config = { ...DEFAULTS, ...(rawConfig ?? {}) };
    const commandSound = resolveSound(config.soundCommand);
    const questionSound = resolveSound(config.soundQuestion);
    const barkSound = resolveSound(config.soundBark);
    /**
     * 观察每次工具执行的最终结果（observe-only，故障被包容）：
     * - bash 工具 → 该 agent 命令计数 +1（成功或失败都算“执行过命令”），并播「大狗」；
     * - ask_user_question 工具 → 播「诶」。
     */
    ctx.effect(() => ctx.on('tools/result', (exec) => {
        if (!config.enabled)
            return;
        if (exec.name === BASH_TOOL) {
            const key = agentKey(exec.agent);
            counts.set(key, (counts.get(key) ?? 0) + 1);
            playFile(commandSound);
        }
        else if (exec.name === ASK_USER_TOOL) {
            playFile(questionSound);
        }
    }), 'dsh-audio-dagou: observe tool results');
    /**
     * 每轮任务结束边界（模型已给出最终回答、无未决工具调用）：
     * 只结算【该 agent 自己】的本轮命令计数，按比例连播「叫」（封顶 maxBarks），
     * 结算后删除该 agent 的计数（清零）。监听器内不阻塞（连播改后台异步）。
     */
    ctx.effect(() => ctx.on('agent/turn-stopping', (payload) => {
        if (!config.enabled)
            return;
        const key = agentKey(payload.agent);
        const n = counts.get(key) ?? 0;
        counts.delete(key);
        const times = Math.min(config.maxBarks, Math.round(n * config.barkScale));
        if (times <= 0)
            return;
        playBarks(barkSound, times, config.barkGapMs, config.barkMaxMs);
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
            });
        },
    })), 'dsh-audio-dagou: status tool');
    // 仅用于模块完整性（host 无客户端注入）。保留 ASSETS_DIR 常量以防误删被引用。
    void ASSETS_DIR;
}
//# sourceMappingURL=index.js.map