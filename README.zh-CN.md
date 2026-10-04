# claude-utopia

> **开发中（Work in progress）。** 接口、名字和默认值在版本之间可能变化。觉得有用的话可以先点个 star，关注后续开发。

[English](README.md)

基于 [mods](https://code.claude.com/docs/en/plugins/mods/overview)（function hooks）的四个 Claude Code 插件，外加两个 agent 模板。

| 插件 | 做什么 |
|---|---|
| `dashboard` | 输入框上方的状态条，显示运行中的子 agent 和 mmrun 外审；上下文用量提示；七页工作台（总览 / Agents / 外审 / GPU / 时间线 / 用量 / 进度），用 `/dashboard`、`/subagents`、`/mmrun`、`/gpu`、`/timeline` 打开。外审、GPU、进度三个标签有数据时才显示：有 `~/.claude/mmruns` 目录、有 GPU 主机、有进度板。时间线页把主循环的每一轮画成模型请求和工具调用的瀑布图，另有热点视图列出最慢的工具和轮次。在对话里画子 agent 卡片、测试摘要和被拦命令的提示。 |
| `harness` | skill：`ai-code-cleanup`、`interrogate`、`shape-task`、`verify-change`、`setup`。守卫：拒绝派指定模型的子 agent；在共享主工作树上拒绝会抹掉未提交改动的 git 命令；拒绝会把 API key 配置文件（`~/.claude.json` 及其备份、Claude 的设置、Codex 的配置与认证、grok 的认证、OpenViking 的配置）内容或环境变量全量输出（`env`、`printenv`、`export -p`、`set` 等）带进对话的工具调用；主线程空闲到 prompt 缓存将过期时自动 `/compact`。 |
| `mm` | 多模型交叉审查与派活：`/mm:review` 让 codex / grok / agy 并行只读审查，`/mm:run` 把任务交给别的模型在独立工作树里做。自带 `mmrun` 命令行工具。守卫拒绝读取 mmrun 的 `*.raw` 事件流（单独一条不超过 50 行的 `tail` 除外），并把前台的 `mmrun wait` 改到后台运行。 |
| `progress` | 按项目的进度板。主模型在回复结束前通过 `progress` 工具把这次对话的工作记成 1–3 个节点（标题、摘要、状态、类型，连到旧节点），存在 `~/.claude/progress/` 下或随项目提交，每个项目选一次。可选的 Artifact 画布同步显示进度板。不依赖 `dashboard`；装了 `dashboard` 时，工作台的进度页列出这块板。 |
| `agents/` | `worker` 与 `researcher` 子 agent 模板，复制到 `~/.claude/agents/` 使用。 |

## 依赖

- Claude Code **2.1.287 及以上**（从这个版本起 mods 默认开启）。终端和桌面端 Code 标签页能绘制界面；VS Code 面板和 `claude -p` 只跑 hook 不绘制。
- `harness`：`python3`。
- `mm`：[codex](https://github.com/openai/codex)、grok、agy 命令行至少装一个，另需 `bash`、`git`、`jq`、`python3`。grok 和 agy 的只读围栏用 `sandbox-exec`，只支持 macOS；codex 用它自带的沙箱。
- `dashboard` 的 GPU 页：能用密钥免密 `ssh` 到目标主机，主机上有 `nvidia-smi`（或 `tegrastats`）。
- 可选：`/mm:run` 在前端任务上建议配合 `/impeccable` skill，`verify-change` 建议使用 `codegraph_impact` MCP 工具。两者都不随本仓库提供；装了就会用上，没装插件照常工作。

## 安装

让 Claude 来装：在 Claude Code 会话里粘贴这一句。

```text
Fetch and follow the instructions in https://raw.githubusercontent.com/Paradox07127/claude-utopia/main/INSTALL.md
```

或者手动：

```bash
claude plugin marketplace add Paradox07127/claude-utopia
```

```bash
claude plugin install dashboard@claude-utopia
```

```bash
claude plugin install harness@claude-utopia
```

```bash
claude plugin install mm@claude-utopia
```

```bash
claude plugin install progress@claude-utopia
```

然后开一个新的 Claude Code 会话。随时可以跑 `setup` skill（`/harness:setup`）查看和修改下面的配置项。

## 配置项

用 `/plugin configure <插件>@claude-utopia` 设置，或 `claude plugin configure <插件>@claude-utopia --values-stdin`，从标准输入传一个值全是字符串的 JSON 对象。改动在下一个会话生效。

| 插件 | 键 | 默认 | 含义 |
|---|---|---|---|
| dashboard | `language` | `auto` | 界面语言：`auto`、`zh-CN` 或 `en`。`auto` 依次看 settings 的 `language`、`LC_ALL` / `LANG`，都不明确时用英文。 |
| dashboard | `gpuHosts` | 空 | 逗号分隔的 ssh 主机名；Bash 里 `ssh <主机> …` 会打开该主机的 GPU 页。 |
| dashboard | `cacheTtlMinutes` | `60` | 兜底的 prompt 缓存时效：主线程空闲这么多分钟后，状态条提醒下一条消息会重写 prompt 缓存。只在真实时效未知时使用；从会话记录读到的时效或切换模型时报告的时效会覆盖它。 |
| dashboard | `toastPeerAsks` | `true` | 别的 Claude Code 会话请求权限或这一轮失败时弹 toast。别的会话的 toast 只在你两分钟内最后输入过的会话里显示；两分钟内哪个会话都没输入过时，每个会话都显示。 |
| dashboard | `toastPeerReplies` | `true` | 别的会话在一轮跑了两分钟及以上后回复时弹 toast。显示规则同上。 |
| dashboard | `askSound` | `false` | 别的会话请求权限或失败的 toast 弹出时，同时播放一声短提示音。需要 `toastPeerAsks` 开着。 |
| dashboard | `toastRuns` | `true` | mmrun 的某个模型返回、失败或停滞时弹 toast。 |
| harness | `language` | `auto` | 同上，用于 harness 的 toast。 |
| harness | `blockedSubagentModels` | `sonnet` | 逗号分隔；模型名包含其中任一项的子 agent 会被拒绝。留空则不拦。 |
| harness | `sharedTreeGitGuard` | `true` | 在主工作树上拒绝会抹掉未提交改动或改写 HEAD 的 git 命令：`checkout <路径>`、`checkout --force` / `-f`、`restore`（单独 `--staged` 除外）、`stash`（`list`、`show`、`create` 除外）、`clean`（`-n` / `--dry-run` 除外）、`switch --discard-changes` / `--force` / `-f`、`reset --hard`、`commit --amend`。linked worktree 里不拦。 |
| harness | `idleCompact` | `true` | 主线程空闲到 prompt 缓存快过期时自动 `/compact`：1h 缓存在过期前 10 分钟、上下文不少于 100k token；5m 缓存在过期前 1 分钟、不少于 200k token。缓存时效从会话记录读取。 |
| mm | `reviewModels` | `codex,grok` | `/mm:review` 没给 `--models` 时用的模型。 |

`progress` 没有配置项。

skill、命令文档以及插件发给模型的指令都是英文；skill 的描述里另带中文触发词，让中文提问也能匹配上。Claude 会用你的语言回复。只有画出来的界面跟随 `language`。

## 隐私与信任

mods 和其他插件 hook 一样，在进程内以你的用户权限运行。`mm` 会把被审查的代码交给你本机装好的外部模型命令行，走它们各自的账号和条款。本仓库的代码不向任何地方上报数据。

当 `~/.claude/agents/` 或项目的 `.claude/agents/` 里有 `worker.md` 或 `researcher.md` 时，`harness` 会隐藏内置的 `general-purpose` agent。

## 许可

[MIT](LICENSE)
