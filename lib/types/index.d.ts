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
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export declare const name = "dsh-audio-dagou";
export declare const inject: string[];
export interface Config {
    /** 总开关：false 时全部静音（仍计数）。 */
    enabled: boolean;
    /** 每执行一条命令后播放的音效。内置：`大狗.wav`；或填任意绝对路径。 */
    soundCommand: string;
    /** 模型提问时播放的音效。内置：`叮咚鸡.wav`；或填任意绝对路径。 */
    soundQuestion: string;
    /** 用户回答完问题后播放的音效。内置：`诶.wav`；或填任意绝对路径。 */
    soundAnswer: string;
    /** 任务结束时连播的叫声音效。内置：`叫.wav`；或填任意绝对路径。 */
    soundBark: string;
    /** 播放次数 = min(round(命令计数 × 该倍数), maxBarks)；默认 1（严格正比）。 */
    barkScale: number;
    /** 每轮结束最多播放几次叫声（需求：≤10）。 */
    maxBarks: number;
    /** 连播叫声之间间隔 ms（让每声可分辨）。 */
    barkGapMs: number;
    /** 每声叫声可被截断的最长时长 ms；0 = 不截断。 */
    barkMaxMs: number;
}
/** 配置声明：loader 在挂载前校验入口 config 并填入默认值。 */
export declare const Config: Schema<Config>;
export declare function apply(ctx: Context, rawConfig?: Partial<Config> | null): void;
