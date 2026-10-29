在 `apps/tilldone/` 下做一个 Electron 桌面版 TillDone，用来代替 Pi 的 TUI 界面。应用本身也按四层结构组织。下面是完整需求，开工前先用 tilldone 建任务列表（建议的任务见文末）。

## 背景（已验证的事实，不要重新猜）

- 应用不嵌入 Pi，而是用 **RPC 模式**把 Pi 作为子进程驱动：
  `pi --mode rpc --no-session --no-extensions --no-skills --model <model> -e <repo>/extensions/tilldone`
- 协议文档在 `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/`：`rpc.md`、`rpc-commands.md`、`json.md`、`rpc-extension-ui.md`。字段名以文档和下面的录制样本为准，不要凭记忆写。
- 真实录制样本：`specs/tilldone-electron/rpc-probe.jsonl`。每行是 `{dir, t, rec}`，`dir` 为 `in`（发给 pi）、`out`（pi 输出）或 `stderr`。录制脚本：`specs/tilldone-electron/rpc-probe.ts`。样本里的情况：
  - 任务数据只从 `tool_execution_end`（`toolName === "tilldone"`）的 `result.details` 取，它是完整快照 `{action, tasks[{id,text,status}], nextId, listTitle?, listDescription?, error?}`。`end` 里的 `args` 是 `null`，调用参数在 `tool_execution_start.args` 里。
  - `extension_ui_request` 的 `confirm`：`{id, method:"confirm", title, message, timeout}`。应答是 `{"type":"extension_ui_response","id":<同一个 id>,"confirmed":true|false}`。超时由 pi 自己处理，客户端只需要到时关掉弹窗。
  - `setStatus` 带 `statusKey`、`statusText`，可以直接显示。
  - `setWidget` 在 RPC 下**永远没有 `widgetLines`**（扩展传的是 TUI 组件工厂，会被忽略）。不要依赖它，“当前任务”从 `details` 里算。
  - `setFooter`、`ui.custom()` 在 RPC 下不起作用。所以 `/tilldone` 命令要由应用在本地拦截（打开或聚焦任务面板），不要发给 pi。
  - 一次运行以 `agent_end → agent_settled` 结束，“空闲”以 `agent_settled` 为准。tilldone 在还有未完成任务时会用 `sendMessage` 发一条 `customType: "tilldone-nudge"` 的消息并自动开始下一轮，界面上要把它和用户消息区分开显示。
  - 帧格式是严格的 JSONL：只按 `\n` 切分，去掉行尾的 `\r`。**不要用 Node 的 `readline`**，它会在 JSON 字符串里的 U+2028/U+2029 处错误断行。

## 四层结构

| 层 | 在应用里是什么 | 规则 |
|---|---|---|
| L1 平台 | pi 子进程和 Electron 运行时 | 不修改。`extensions/tilldone/` 一行都不要改。 |
| L2 胶水 | 主进程：启动 pi、JSONL 收发、命令和应答按 id 对应、把每条记录交给 L3、把新的视图模型通过 IPC 推给 renderer、把 renderer 的意图（prompt / steer / abort / 确认应答）转成 RPC 命令 | 唯一持有可变状态的地方。不写业务规则。 |
| L3 领域 | 纯函数：`reduce(state, rpcRecord) → state`，以及 `toViewModel(state)` | 不 import Electron、Node 或 L2/L4，`bun test` 不启动 Electron 就能跑。任务相关的选择器优先复用 `extensions/tilldone/state.ts` 导出的 `countByStatus`、`current`、`STATUS_ICON`（它本身零依赖），不要复制一份。确实复用不了时，在 README 里写明原因。 |
| L4 渲染 | renderer 页面 | 只负责把视图模型画出来、把用户操作作为意图发出去。不解析 RPC 记录，不存业务状态。 |

视图模型在主进程里算好，以纯 JSON 推给 renderer，renderer 不需要任何共享代码。

## 功能（MVP，不要多做）

1. 输入框：空闲时发 `prompt`；运行中可以 steer 或 follow-up（看 `rpc-commands.md`），有停止按钮（`abort`）。
2. 对话区：流式显示助手文本；工具调用默认折叠，显示工具名、参数和结果；nudge 消息单独样式。
3. 任务面板：标题、进度、每个任务的状态图标，高亮当前任务。数据只来自 `details`。
4. 确认弹窗：显示 title 和 message，带按 `timeout` 走的倒计时，允许 / 拒绝。`select`、`input`、`editor` 这次不做，收到时立即回 `cancelled: true`，避免 pi 一直卡住。
5. 状态栏：模型、思考深度、是否运行中（来自 `get_state`）、tilldone 的 status 文本、工作目录。
6. pi 子进程退出或崩溃时，界面明确提示，并提供“重启”按钮。

## 配置与计费（必须遵守）

- 默认模型 `openai-codex/gpt-6.1-sol`，可以用环境变量 `TILLDONE_MODEL` 覆盖。**拒绝任何 `anthropic/*` 模型**，直接报清楚的错误后退出：那条路走按量计费的 API，用户没有充值。
- pi 可执行文件默认用 PATH 里的 `pi`，可以用 `TILLDONE_PI_BIN` 覆盖（测试会用它换成假的 pi）。
- 工作目录默认是启动时的 `process.cwd()`，可以用 `TILLDONE_CWD` 覆盖，并显示在状态栏。
- 扩展路径从应用目录解析到仓库的 `extensions/tilldone`，不要写死绝对路径。

## 工程约定

- 参照 `apps/stock-ticker/` 的结构和安全做法：renderer 开 sandbox 和 contextIsolation，关闭 nodeIntegration，配 CSP，外部文本用 `textContent`，IPC 校验来源，preload 只暴露很窄的 API（大约是 `send(intent)` 和 `onView(cb)`）。
- 用 bun，Electron 版本和 stock-ticker 一致（`^45.1.0`，配 `trustedDependencies`）。源码用 TypeScript，需要构建的话用 `bun build`，在 package.json 里提供 `build`、`start`、`test`。
- 代码和注释用英文，风格对齐 `extensions/tilldone/`：每个文件开头用一段注释说明自己属于哪一层、负责什么。
- 在 justfile 末尾 `# utils` 之前加 recipe：`tilldone-desk-install`、`tilldone-desk`、`tilldone-desk-test`，写法照抄 stocks 那几个。
- 不改 `extensions/`、`apps/stock-ticker/`、`walkthroughs/`。不要 git commit。

## 测试（全部不调用真实模型）

1. **L3 单元测试**：把 `rpc-probe.jsonl` 复制到 `apps/tilldone/test/fixtures/`，按顺序把 `out` 记录喂给 `reduce`，断言：
   - 加完任务后有 alpha、beta 两个任务，状态都是 idle；
   - 某个中间时刻 alpha 是 done、beta 是 inprogress，当前任务是 beta；
   - confirm 出现时 state 里有一个待处理的弹窗；
   - 清空之后任务列表为空；
   - 收到 `agent_settled` 后不再是运行中；
   - 助手文本由 `text_delta` 正确拼接。
2. **L2 测试**：
   - JSONL 切帧：一条记录被拆成几块到达、一块里有多条记录、JSON 字符串里含 U+2028，三种情况都正确；
   - 写一个假的 pi 脚本（通过 `TILLDONE_PI_BIN` 注入），回放样本里的 `out` 记录。遇到 confirm 时等应答，验证 L2 会发出 id 正确的 `extension_ui_response`；
   - 验证 `anthropic/*` 模型会被拒绝。
3. 最后跑 `just tilldone-desk-test`，全部通过。然后用 `just tilldone-desk` 真实启动一次，确认窗口能打开；用户会自己发 prompt 做手动验证。

## 建议的任务列表

1. 读背景材料：协议文档、`rpc-probe.jsonl`、`extensions/tilldone/`、`apps/stock-ticker/`
2. 搭骨架：package.json、tsconfig、构建、justfile recipe
3. L3：reducer 和视图模型，以及基于 fixture 的单元测试
4. L2：pi 进程管理、JSONL 收发、id 关联、UI 应答，以及假 pi 测试
5. L2：Electron 主进程、preload、IPC
6. L4：renderer 页面（对话区、任务面板、确认弹窗、状态栏）
7. README（运行方式、四层说明、RPC 限制、安全）；跑全部测试；真实启动一次
