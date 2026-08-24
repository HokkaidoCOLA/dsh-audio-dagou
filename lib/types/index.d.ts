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
 *   5. 模型用 `read` 工具读取【工作区之外】的文件（读取成功时）→ 先播
 *      「叮咚鸡.wav」（与提问同款）、再播「诶.wav」（与回答确认音同款默认音效）：
 *      任一沙箱 mode 下读取都不受限，读出的内容可能来自工作区之外，读取成功
 *      的瞬间补一声提问式提醒 + 一声确认。默认音效即上两项；`soundReadOutside`
 *      可单独换掉「诶」，提问音跟随 `soundQuestion`。工作区边界 = 会话 cwd ∪
 *      `workspaceRoots` 配置根（会话目录与项目目录不一致时把项目目录配上）；
 *   6. 模型【请求放权】（`sandbox_permissions` 升级触发用户审批弹窗）时 →
 *      播「叮咚鸡.wav」；用户批准（approval 返回 `allowed-once`）的瞬间 →
 *      播「诶.wav」。挂在 `approval/request`（waterfall，与提问音效同构）：
 *      请求投递到答题链（弹窗出现）前出声、`next()` 决议（用户允许/拒绝）后
 *      确认——批准才播「诶」；拒绝/取消/无人应答则保持安静。
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
    /** 读工作区外文件时后播的音效（先播一声提问音 `soundQuestion`，再播它）。内置：`诶.wav`（回答确认音同款）；或填任意绝对路径。 */
    soundReadOutside: string;
    /**
     * 额外计入「工作区」的绝对路径根（数组）。
     *
     * 「读工作区外」的判定以会话 cwd 为边界；当会话工作目录与【实际在操作的项目】
     * 不一致时（例如 Web GUI 会话建在别的目录、而插件/项目在另一目录），把项目根
     * 填到这里，读项目内文件就不会再被当成「工作区外」而提醒。为空 = 只用会话 cwd。
     */
    workspaceRoots: string[];
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
/**
 * 判定 targetPath（相对或绝对路径）是否位于 workspaceRoot 之内（含根自身）。
 *
 * 与 dsh-tool-fs 的 `read` 工具同口径：相对路径以工作区为基解析；两侧都经
 * `realpathDeepest` 归一化后再比较（win32 大小写不敏感，其余平台敏感）。
 * 导出它是为了冒烟测试能直接覆盖判定逻辑（前缀误判 / 越级、symlink 别名、大小写）。
 */
export declare function isPathContained(workspaceRoot: string, targetPath: string): boolean;
/**
 * 判定目标路径是否属于「工作区」：会话 cwd 之内，或任一 `workspaceRoots`
 * 配置根之内（缺 cwd 时仅看配置根）。
 *
 * `workspaceRoots` 用于「会话工作目录 ≠ 实际项目目录」的场景（Web GUI 的会话
 * 可能建在别的目录，而插件项目在另一目录）——把项目根配进去后，读项目内文件
 * 就不再被当成「工作区外」。cwd 与配置根**都缺**时返回 false——调用方必须先
 * 确认边界「可知」（见 tools/result 监听器里的 workspaceKnown 门控），否则
 * 所有 read 都会被误判为工作区外。导出它是为了冒烟测试能直接覆盖合并判定逻辑。
 */
export declare function isWorkspacePath(cwd: string | undefined, targetPath: string, workspaceRoots: readonly string[]): boolean;
export declare function apply(ctx: Context, rawConfig?: Partial<Config> | null): void;
