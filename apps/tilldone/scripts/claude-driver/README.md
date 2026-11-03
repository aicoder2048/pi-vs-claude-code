# Claude driver：无人值守地驱动边牧干活

让 Claude Code（或你自己）把一个长任务交给**真实的边牧桌面**（Electron + Pi + TillDone，默认开 pstack Poteto Mode），不用人守着，跑完再读结果。

它会启动桌面窗口，粘贴 prompt 并发送，然后定时看一眼桌面：确认框一律拒绝，提问框一律取消，任务清单有变化就记一笔。桌面空闲够久算跑完，桌面报警或超时就停。最后把截图、对话、任务清单和一份 `summary.json` 写进运行目录。

> ⚠️ 用的是真实模型，消耗 Codex 订阅额度。`anthropic/*` 在启动前就被拒绝（按量计费，没有余额），规则和桌面自己的 `src/config.ts` 是同一份。

## 快速开始

在 `apps/tilldone` 目录：

```bash
just drive --work /abs/path/to/project --prompt my-task.md --name build
# 等价于
bun scripts/claude-driver/desk-run.ts --work /abs/path/to/project --prompt my-task.md --name build
```

- 默认开 pstack，所以 `--work` 指向的项目要先装好：`pi install npm:pi-pstack -l`。不需要时加 `--no-pstack`。
- prompt 怎么写见 [`prompts/TEMPLATE.md`](prompts/TEMPLATE.md)。
- 每次运行前驱动会先 `bun run build`，保证跑的是当前代码。

## 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--work <dir>` | 必填 | 桌面的工作目录（`TILLDONE_CWD`） |
| `--prompt <file>` | 必填 | 原样粘进桌面的 prompt |
| `--out <dir>` | `<tmp>/tilldone-runs/<时间戳>-<name>` | 运行目录；必须是新目录或空目录，不会覆盖上一次 |
| `--name <name>` | `run` | 运行名，只用于默认运行目录 |
| `--model <id>` | `openai-codex/gpt-6.1-sol` | 会话模型；`anthropic/*` 被拒绝 |
| `--no-pstack` | 开 | 不加载 pstack |
| `--max-min <n>` | 150 | 硬时限（分钟） |
| `--poll-sec <n>` | 15 | 每隔几秒看一次桌面 |
| `--idle-sec <n>` | 20 | 空闲多少秒算跑完 |

参数有错、目录不存在、prompt 为空、运行目录已有内容、模型是 `anthropic/*`、要 pstack 但项目没装，都会在启动窗口**之前**失败（退出码 1）。

## 结果

退出码：`0` 跑完（settled），`1` 驱动出错，`2` 桌面报警（例如 Pi 崩溃），`3` 到了时限桌面还在忙。

运行目录：

| 文件 | 内容 |
| --- | --- |
| `summary.json` | **先读这个**：outcome、detail、用时、模型、拒绝过的确认框、取消过的提问框、任务清单变化次数、最终任务清单、页面报错 |
| `run.log` | 带时间戳的过程：连接、任务清单变化、对话框、结局、对话尾部、诊断输出 |
| `conversation.txt` | 结束时的对话面板全文 |
| `tasks.txt` | 结束时的任务面板 |
| `final.png` | 结束时的截图 |
| `userdata/` | 这次运行专用的 Electron 配置目录，不碰你平时的桌面设置 |

## 看守策略

`lib/watch.ts` 是纯函数，测试覆盖：

1. 确认框打开 → 拒绝。没人批准时，拒绝是安全的答案。
2. 提问框（select / input / editor）打开 → 取消。驱动没有答案可给，所以 prompt 里要把决定写清楚。
3. 桌面报警 → 结束，outcome `alert`。
4. Stop 按钮持续禁用满 `--idle-sec` → 结束，outcome `settled`。刚回答过对话框的那一轮不算空闲。
5. 到 `--max-min` → 结束，outcome `deadline`。

## Claude Code 怎么用

1. 按 `prompts/TEMPLATE.md` 写 prompt，放进 scratchpad。
2. 用后台方式运行（Bash 的 `run_in_background`），`--out` 指到 scratchpad 里一个新目录；长任务通常几十分钟到两小时。
3. 跑完后先读 `summary.json`，再按需看 `run.log`、`conversation.txt` 和 `final.png`；然后去 `--work` 里核对边牧真正改了什么、测试过没过。
4. 中途断了：当前没有续接，写一份带“续跑说明”的新 prompt 再跑一次（见归档里的 `blackjack-fix-prompt2.md`）。

## 目录

```
desk-run.ts        入口：解析参数 → 预检 → 构建 → 启动桌面 → 看守循环 → 收集结果
lib/options.ts     参数解析（纯函数）与启动前预检（复用桌面的 loadConfig）
lib/watch.ts       看守策略（纯函数）与退出码
lib/desk.ts        桌面 DOM 的唯一入口：选择器表 + Playwright 封装；渲染器改 id 时只改这里
prompts/           prompt 模板和例子（pstack-arena-check.md：并行跑两个 arena 子 agent 的快速检查）
archive/           2026-11-01 Blackjack 实战留下的原始脚本和 prompt，见其中 README
```

## 测试

- `bun test test/claude-driver.test.ts`：参数、预检、看守策略，离线。已包含在 `bun run test`。
- `bun test/claude-driver-smoke.ts`：用假 pi 真开窗口跑三次（正常跑完并拒绝一个确认框、Pi 崩溃后报警、`anthropic/*` 启动前被拒），不调用模型。已包含在 `bun run test:smoke`。

## 已知限制

- 一次运行只发一个 prompt，不续接会话。
- 确认框只会拒绝，不会批准；需要批准的操作在 prompt 里换个不需要确认的做法。
- 子 agent 的计费门只管第一层（见桌面 README 的 Configuration 一节）。如果 pstack 的 role 映射到 `anthropic/*`，这类子 agent 调用会被拦下，`pstack-arena-check.md` 也会因此失败。
