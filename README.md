# dsh-audio-dagou

给 DeepSeek Harness（DSH）会话配点动物系音效的宿主插件：模型干活时「大狗」，提问时「诶？」，读到工作区外文件时「诶」（同款回答确认音），一轮任务收尾按命令条数成比例「汪汪汪」地叫（最多 10 声）。


## 环境要求

| 项目 | 要求 |
|------|------|
| 运行时 | DeepSeek Harness (DSH) 0.1.x（0.1.0-rc.6 及以上均可） |
| Node.js | ≥ 20 |
| 前置插件 | 无 |

### 三平台播放器（按序回退）

| 平台 | 播放器 | 说明 |
|------|--------|------|
| macOS | `afplay` | 系统自带 |
| Windows | `powershell`（`System.Media.SoundPlayer`） | 系统自带 |
| Linux | `paplay` → `pw-play` → `aplay` | PulseAudio / PipeWire / ALSA，自动回退 |

> 任何平台找不到播放器或音频文件时都**静默跳过**，绝不影响工具执行或回合收尾。

## 行为

| 事件 | 音效 | 说明 |
|------|------|------|
| 模型执行一条 `bash` 命令后 | `大狗.wav` | 命令计数 +1（该 agent 名下） |
| 模型调用 `ask_user_question` 提问时（提问界面弹出瞬间） | `叮咚鸡.wav` | 挂在 `tools/execute`，不等用户作答 |
| 用户回答完问题后（答案提交瞬间） | `诶.wav` | 挂在 `tools/result`——工具此时刚返回，作确认音 |
| 模型用 `read` 读取到**工作区之外**的文件时 | `叮咚鸡.wav` → `诶.wav` | 先提问音、再回答确认音（顺序播，间隔 150ms）；见下方判定口径 |
| 每轮用户请求结束（agent turn 收尾） | `叫.wav` × N | N = min(round(本轮命令计数 × barkScale), maxBarks)，随后清零 |

> - 「成正比例」默认 `barkScale = 1`（几次命令就几声），封顶 `maxBarks`（默认 10）。
> - 命令计数**按 agent 隔离**：subagent 的回合结束只结算它自己的计数，不会误清零主 agent、也不会白叫。
> - 「读工作区外」判定口径与 `read` 工具自身一致：相对路径以会话工作区（cwd）为基，
>   两者都经 realpath 归一化（`/tmp` → `/private/tmp`、工作区内 symlink 指向外部的
>   文件都能正确识别，win32 大小写不敏感）；**仅读取成功时触发**（读失败、读到目录
>   不算）。任一沙箱 mode 下读取都不受限，故该音效与 mode 无关。此时先播
>   `soundQuestion`（`叮咚鸡.wav`）再播 `soundReadOutside`（默认 `诶.wav`），
>   两声间隔 150ms。
> - 音频播放全部 fire-and-forget、不阻塞任何流程。

## 安装（装配进 web profile）

### 方式 A：GitHub 装配（推荐）

本仓库已提交构建产物（`lib/`），git 装配**免构建**：

```bash
dsh plugin --profile web add github:HokkaidoCOLA/dsh-audio-dagou
```

本包 `package.json` 声明了 `dsh.bundle.patch`，安装后自动并入 profile 的 bundle 层并激活（无需手动编辑 `cordis.patch.yml`）。装配后**重启 `dsh web`** 生效。

### 方式 B：本地源码装配（开发调试）

```bash
cd dsh-audio-dagou
npm install
npm run build

dsh plugin --profile web add "$(pwd)"
```

### 配置覆写

后续层（profile 的 `cordis.patch.yml`、`--patch`）可按 id 覆写 config，例如在
`$DSH_HOME/profiles/web/cordis.patch.yml` 追加（注意保留 `- insert:` 包裹）：

```yaml
- insert:
    - id: dsh-audio-dagou
      config:
        enabled: true
        maxBarks: 10
        barkScale: 1
        barkGapMs: 420
        # 换自己的音频：填绝对路径即可
        # soundCommand: /path/to/汪.wav
        # soundQuestion: /path/to/叮咚鸡.wav
        # soundAnswer:  /path/to/确认音.wav
        # soundReadOutside: /path/to/读外面啦.wav
        # soundBark:    /path/to/叫.wav
```

## 配置项

| 键 | 默认 | 说明 |
|----|------|------|
| `enabled` | `true` | 总开关；false 时静音（仍计数） |
| `soundCommand` | `大狗.wav` | 命令音效（内置名或绝对路径） |
| `soundQuestion` | `叮咚鸡.wav` | 提问音效（提问界面弹出瞬间） |
| `soundAnswer` | `诶.wav` | 回答确认音（用户提交答案瞬间） |
| `soundReadOutside` | `诶.wav` | 读工作区外音效（先播一声 `soundQuestion` 提问音，再播它） |
| `soundBark` | `叫.wav` | 收尾连播音效 |
| `barkScale` | `1` | 播放数 = 命令数 × 此倍数 |
| `maxBarks` | `10` | 每轮最多几声（需求 ≤10） |
| `barkGapMs` | `420` | 连播间隔 ms |
| `barkMaxMs` | `0` | 单声截断时长；0 = 不截断 |

## 模型侧探针工具

- `audio_dagou_status` — 查询各 agent 本轮命令计数、配置、音频文件是否就位、使用的播放器。

## 开发

```bash
npm ci          # 安装依赖
npm run build   # tsc → lib/
npm run typecheck
npm test        # scripts/smoke.mjs（三平台通用冒烟测试）
```

## 许可

BSD-3-Clause © 2026 HokkaidoCOLA
