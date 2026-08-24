# 变更记录

版本号为 `0.0.x` 递增，每个版本对应一个 `v0.0.x` git tag。

## v0.0.6

主题：**请求放权也有动静了——审批弹窗「叮咚鸡」，批准后「诶」**。

- **新增：放权审批链路配音效。** 模型发起 `sandbox_permissions` 升级（写/改工作区
  外文件、bash 升级等，需要用户放权）时：请求投递到答题链（审批弹窗出现）瞬间
  播「叮咚鸡」（与提问同款）；`next()` 决议为 `allowed-once`（用户批准）瞬间播
  「诶」（回答确认音）。挂在 `approval/request`（`dsh-user-approval` 的分发
  waterfall，与 `tools/execute` 提问音效同构）：监听器只旁观 + 无条件转发决议，
  不拦截、不替换；**拒绝 / 取消 / 无人应答（fail-closed）静默**。
  `write` / `edit` / `bash` 的升级请求共用同一条审批链，全部覆盖。
- **类型：`import type { ApprovalOutcome }` 来自 `dsh-user-approval`**（宿主
  profile 必装；本包未新增运行时依赖）。
- **冒烟测试：** 新增 `approval/request` 接线检查与「决议原样放行」用例。
- 说明：审批策略为 `never`（自动拒绝、无弹窗，CI 场景）时请求仍会过链——只会
  响一声「叮咚鸡」、不响「诶」，可接受。

## v0.0.5

主题：**读工作区外的判定可配置——会话目录与项目目录不一致时不再误报**。

- **修复（实锤根因）：Web GUI 会话的 DSH 工作目录 ≠ 实际项目目录，导致读项目内
  文档/代码也被判「工作区外」而频繁提醒。** 取证：`session_projcache.json` 显示
  当前 GUI 会话 `identity.cwd = /Users/Apple/Documents/dsh/dsh-dagou-rewind`，
  而插件项目在 `dsh-audio-dagou`——插件与 `read` 工具口径一致地以会话 cwd 为
  边界，于是项目内文件的每次读取都触发了「叮咚鸡→诶」。
- **新增配置 `workspaceRoots`**（绝对路径数组，默认 `[]`）：判定从「仅会话 cwd」
  扩展为「会话 cwd ∪ workspaceRoots」，把项目根配上即恢复「只对真正的工作区外
  访问（如 `.nvm`、`/etc`）提醒」。已连同 `dsh-audio-dagou` 项目根写入
  profile 的 `cordis.patch.yml`。
- **新增导出纯函数 `isWorkspacePath(cwd, target, roots)`**，冒烟测试覆盖合并判定
  （cwd 内 / 额外根内 / 都不在 / 缺 cwd 时按根判定）。
- **边界不可知时不播：不回归 v0.0.4 的「宁可少响不误报」。** cwd 与 workspaceRoots
  都拿不到时（无 agent 归属的 SDK / run_code 子调用）不触发「叮咚鸡→诶」，
  `tools/result` 监听器以 `workspaceKnown` 门控兜底，冒烟测试补充该场景。
- **`audio_dagou_status` 上报 `config.workspaceRoots`**。

## v0.0.4

主题：**读工作区外文件也有动静了——和回答问题同款「诶」**。

- **新增：`read` 工具读到工作区外文件时先播 `叮咚鸡.wav`、再播 `诶.wav`。** 「叮咚鸡」
  即提问音效（跟随 `soundQuestion`），「诶」与回答确认音同款（可经 `soundReadOutside`
  单独换）；两声顺序播放、间隔 150ms，避免混在一起。判定口径与
  `read` 工具自身一致：相对路径以会话 cwd（工作区）为基，两侧都先 realpath 归一化
  （`/tmp` → `/private/tmp`、工作区内 symlink 指向外部的文件都能正确识别），win32
  大小写不敏感；**仅读取成功时触发**（读失败、读到目录不算）。任一沙箱 mode 下
  读取都不受限，因此该音效与 mode 无关——「确实读到了工作区之外的内容」才值得出声。
- **新增配置 `soundReadOutside`**（默认 `诶.wav`，即回答确认音同款）：读工作区外时
  「诶」可单独换声；「叮咚鸡」不走它、跟随 `soundQuestion`。`audio_dagou_status`
  同步上报 `installed.readOutside` 与 `config.soundReadOutside`。
- **健壮性：`read` 结果分支不缺字段也不崩。** `file_path` 缺失 / 非字符串时静默
  跳过；拿不到会话 cwd（无 agent 的非会话调用）时跳过——宁可少响一次也不误报。
- **测试：导出纯函数 `isPathContained` 并补冒烟用例。** 覆盖相对/绝对路径、上层
  越界、前缀相似兄弟目录（`/a` 不包含 `/a2`）、symlink 别名（`/tmp` → `/private/tmp`
  场景）、工作区内 symlink 指向外部、win32 大小写；并验证 read 结果不计入命令计数。

## v0.0.3

主题：**提问音效改为「提问瞬间」触发，不再等用户答完才响**。

- **修复：提问音效时机错误。** 原来 `诶.wav` 挂在 `tools/result`（工具执行结束的
  观测事件），而 `ask_user_question` 的工具体会阻塞直到用户作答——声音实际是在
  用户回答完之后才播放。现在改为挂在 `tools/execute`（环绕分发层）：审批门禁放行
  后、提问工具体运行（弹出提问界面）之前立即播放，即「模型提问的那一刻」。
  `tools/result` 不再承担提问音效；其「工具执行结束」语义保留给回答确认音（见下）。
- **健壮性：`tools/execute` 环绕层严格旁观。** 只播放音效并无条件转发 `next()`，
  不改 `exec.signal`、不替换结果，保持 around 分发语义安全。
- **默认提问音效换成「叮咚鸡」**（`assets/叮咚鸡.wav`，取自本地素材库，转入插件
  包内自包含）：Float32 源转码为 PCM 16-bit 48kHz，保证三平台播放器
  （afplay / Windows SoundPlayer / paplay）都能出声。
- **新增回答确认音 `soundAnswer`**（默认 `诶.wav`）：`ask_user_question` 的工具体
  阻塞到用户作答才返回，因此挂回 `tools/result` 播放「诶」的时机恰为「用户提交
  答案瞬间」——提问时叮咚鸡、回答后诶，两条链路互不干扰。`audio_dagou_status`
  同步上报 `soundAnswer` 与就位情况。
- **修复：`enabled=false` 与「仍计数」文档不符。** 原来监听器在 `enabled` 检查后
  直接返回，禁用期间命令不再计数、回合结束也不再清零（计数只进不清）。现在计数
  与清零不受 `enabled` 影响，只有播放被门控——与 Config 注释 / README 承诺一致。
- **修复：热重载可能留下悬挂的连播循环与 Windows 野声。** `dispose()` 清掉间隔
  定时器后，正挂在 `await sleep(gapMs)` 上的异步循环因 Promise 永不 settle 而
  无限悬挂；现改为定时器与「dispose 信号」竞速，卸载即唤醒退出；并记录 Windows
  分支的 PowerShell 子进程，dispose 时一并终止。
- **文档：配置覆写示例补上 `- insert:` 包裹。** 原示例只有条目行，照抄会生成
  无法解析的 patch 文件；已修正为 profile `cordis.patch.yml` 的正确写法。

## v0.0.2

主题：**热路径不再碰文件系统，待播的叫声不再拖住 host 退出**。

- **修复：待播叫声会把 host 进程拖住不退出。** 连播间隔与「最长播放时长」看门狗
  的定时器没有 `unref`，一串待播定时器会硬拖住事件循环；现在改为 `unref`，并在
  播放子进程退出时清除看门狗。实测带 10 声待播（`barkGapMs` 5s）的进程退出耗时
  **50121ms → 1369ms**。
- **修复：热重载后连播仍在后台出声。** 连播控制器挂到 `ctx.effect`，卸载 / 热重载
  时中断，不再留下「野声」。
- **性能：`playFile` 不再每次播放前 `existsSync`。** `tools/result` 是热路径（模型
  每执行一条命令都会过），原来每次都压一次同步系统调用，并在路径配错时把同一行
  警告刷满整个会话日志。三个音效改为 `apply` 时解析并校验一次：热路径
  **0.84µs → 0.08µs**，警告日志 **20001 行 → 3 行**。
  > 说明：单次省下的时间本身可以忽略，真正的收益是**日志不再刷屏**、以及事件
  > 循环上少一次阻塞式系统调用。
- **性能：Windows 连播由 N 个进程降为 1 个。** 原来 10 声要开 10 个 PowerShell，
  每个约 100ms 冷启动；现在在单个进程内循环播完，**10 次 spawn → 1 次**。
- **性能：连播最后一声之后不再多睡一个 `barkGapMs`。**
- **修复：命令计数 Map 会无界增长。** 被强制中断、崩溃或没走到 turn 边界的 agent
  会留下孤儿键，而长期运行的 host 里 subagent id 各不相同。现在封顶 **256** 并按
  插入序淘汰最旧的键。
- **健壮性：计数与连播状态从模块级移入 `apply` 作用域。** 热重载即重置，插件被
  装载两次时两个实例不再互相串扰。

## v0.0.1

- 首个发布：给 DSH 会话配音效的宿主插件。模型每执行一条 `bash` 命令后播「大狗」，
  向用户提问（`ask_user_question`）时播「诶」，每轮任务结束按命令次数成正比连播
  「叫」（默认上限 10 声）；命令计数按 agent 隔离。
- Win / macOS / Linux 三端可用（`afplay` / PowerShell `SoundPlayer` /
  `paplay`→`pw-play`→`aplay`）。
- 提供 `audio_dagou_status` 工具查询计数、配置与音频就位情况。
