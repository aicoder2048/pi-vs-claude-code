# 边牧（TillDone Desk）结构梳理：四层架构、上下文管理、TillDone 拆分与 PStack 的分工

> 快照：仓库 `pi-vs-claude-code`，提交 `f112eb9`（2026-11-03）。
> 范围：`apps/tilldone`（桌面端）、它自带的扩展副本 `apps/tilldone/extensions/tilldone/`，以及项目本地安装的 `pi-pstack`（`.pi/npm/node_modules/pi-pstack/`）。
> 来源可信度：源码 > README > 白皮书 > 讨论稿。白皮书 `apps/tilldone/docs/tilldone-desk-whitepaper.md` 是 v1.0（2026-10-31），**没有覆盖 pstack 部分**。用户决定等设计固定后再更新白皮书。
> 本文由 Claude Code 在 2026-11-03 读源码后整理。标“推断”的地方没有实际运行验证。

## 0. 一句话结论

边牧是一个 Electron 桌面应用。它不嵌入 Pi，而是用 `pi --mode rpc` 起一个子进程，用 JSONL 驱动它。子进程里加载两个扩展：TillDone，以及可选的 PStack（`TILLDONE_PSTACK=1`）。

- TillDone 立规矩：先列清单、认领任务才许动手（门禁）；没做完就催一次（督促）。
- PStack 给做法：playbook、原则、`subagent` 分派、按角色选模型。
- TillDone 管“做什么、做完没”，用硬约束守住。PStack 管“怎么做”，只靠提示词引导。
- 两者在代码里只有三个接缝。“两份清单怎么配合”没有写进任何模型能看到的提示词。

比喻（`discussions/2026-10-29-tilldone-naming-border-collie.md`）：任务是羊，装了 TillDone 的 AI 是边牧，用户是牧羊人。口号“羊不进圈，边牧不歇”。

## 1. Pi 的双循环（背景）

- **settle 外循环**：`AgentSession._startRun()` 里的 `while`。一个 run 结束后，如果有重试、压缩、排队消息，就再起一个 run。停稳时发出 `agent_settled`。
- **run 内循环**：`agent-loop.js` 的 `runLoop()`。一个 turn = 一次 LLM 请求 + 这条回复里所有工具调用。
- 用户一句话 = 一次 settle。通常 1 个 run；被督促时 2 个 run（督促每条用户消息最多一次）。
- 运行中插话（steer）也会触发 `input` 事件，复位督促闩锁（Pi 1.4.0 `agent-session.js` 的 `steer()` → `_queueUserInput()` → `_runInputHandlers()`）。所以插过话的 settle 可能被督促不止一次，run 数也可能超过 2（读源码推断，没有实际运行验证）。
- 桌面端只把 `agent_settled` 当“空闲”。`agent_end` 不算空闲，因为督促会让外循环再转一圈（`src/domain.ts:223`）。

## 2. 四层架构：两套四层叠在一起

四层定义来自 `discussions/2026-10-28-four-layer-harness.md`：L1 Pi 运行时（搬运和累积上下文）、L2 ExtensionAPI 胶水（不放业务规则）、L3 业务逻辑（决定什么信息进上下文）、L4 界面（独立的数据通道，不占上下文）。

| 层 | 扩展（E-，在 Pi 子进程里） | 桌面（D-，在 Electron 里） |
|---|---|---|
| L1 | Pi 本身，不改 | 外部 `pi` 子进程 + Electron 运行时 |
| L2 胶水 | `extensions/tilldone/index.ts`：持有唯一的 `model` 单元，把 Pi 事件翻译成 L3 调用 | `src/desk.ts`、`rpc.ts`、`jsonl.ts`、`main.ts`、`config.ts`、`credentials.ts`：唯一持有可变状态 |
| L3 领域 | `extensions/tilldone/state.ts`：零 import；模型能看到的所有字符串都定义在这里 | `src/domain.ts`、`appearance.ts`、`api-domain.ts`：纯函数 `reduce(state, record)`、`planIntent`、`toViewModel` |
| L4 渲染 | `ui.ts`：TUI；RPC 下大多不起作用 | `renderer/`：只画 JSON 视图、只发意图 |

- 两套结构之间只有一条依赖：D-L3 import E-L3 的 `parseDetails`、`countByStatus`、`current`、`STATUS_ICON`。所以任务数据格式只定义一次。
- 桌面端从不调用 `gate` 或 `runTool`。规矩只在 Pi 进程里执行一次，桌面端只做投影。
- `state.ts` 开头写明“Zero imports by design”，测试强制检查。

子进程命令（`src/config.ts:26-28`）：

```text
pi --mode rpc --no-extensions --model <model> -e <app>/extensions/tilldone [-e <cwd>/.pi/npm/node_modules/pi-pstack/extensions/pstack -a] [--session <file>]
```

`--no-extensions` 让全局扩展（`~/.pi/agent/extensions`）不加载，只加载这两个。`-a` 信任工作目录里的项目本地文件，pstack 的技能需要它。

接上 pstack 后的进程图：

```
Electron 主进程 (D-L2/L3) ──JSONL──▶ pi --mode rpc --no-extensions
                                       ├─ -e tilldone   (E-L2/L3/L4)
                                       └─ -e pi-pstack  (单文件 index.ts，442 行)
                                              └─ subagent ─spawn─▶ pi --mode json --print --no-session
                                                                  (不加载 tilldone)
```

pstack 自己不分四层：命令、钩子、工具都写在 `pi-pstack/extensions/pstack/index.ts` 一个文件里。在边牧结构里，它是 D-L1 子进程里和 TillDone 并列的第二个扩展。

### 2.1 不变量：谁是权威

| 事实 | 权威 | 桌面端怎么拿到 |
|---|---|---|
| 任务清单 | 扩展的 `model.list` | 只从 tilldone 工具的 `tool_execution_end` 里的 `result.details` 取完整快照 |
| 当前任务 | 清单里第一个 `inprogress` | `current(list)` 现算 |
| 是否在运行 | Pi 的 run 状态 | `agent_start` 置真，`agent_settled` 置假 |
| 每个任务的工具次数、模型请求次数 | 桌面端 D-L3 自己数 | 从 `tool_execution_start`、`turn_start` 计数；不进模型上下文 |

## 3. 上下文管理

原则（四层讨论稿第 3 节）：**上下文管理是手段，业务语义是内容。** 每个进入上下文的字段都要回答“它帮模型做哪个决策”。

### 3.1 两个扩展往模型上下文里放了什么

| 来源 | 内容 | 进入方式 | 频率 |
|---|---|---|---|
| TillDone | 工具说明：九个动作 + “拆小”原则（`state.ts` 的 `TOOL`） | 工具声明 | 每次请求 |
| TillDone | 清单变化 | tilldone 工具结果 | 每次调用 |
| TillDone | 门禁拒绝理由 `GATE_REASON` | 工具错误（“错误即提示词”） | 被拦时 |
| TillDone | `SPLIT_CUE`；每 15 次工具调用的拆分提示 | 追加在工具结果末尾 | `start` 时；每满 15 次 |
| TillDone | 督促 `tilldone-nudge` | 自定义消息，走 steer 队列 | 每条用户输入最多一次 |
| PStack | 一段 Poteto Mode 说明 | `before_agent_start` 追加到 system prompt | Poteto 开启后每次请求 |
| PStack | 整份 `poteto-mode/SKILL.md` | 首条消息 `/skill:poteto-mode …` 由 Pi 展开 | 一次，之后留在历史里 |
| PStack | `pstack_todo` 清单 | 工具结果文本 | 每次调用 |
| PStack | 子 agent 的产出 | 只回传最终文本；并行模式每个子 agent 截断 | 每次 `subagent` |

PStack 追加的 system prompt 原文（`pi-pstack/extensions/pstack/index.ts:272-276`）：

> Pstack Poteto Mode is enabled for this session. Follow its persisted workflow: use pstack_todo for non-trivial work, select and read the matching playbook, delegate through the subagent tool when delegation helps, verify real behavior, and name only principles that changed a decision.

### 3.2 不进上下文的内容

- `spent`（当前任务已用工具次数）和 `nudged`（本条输入是否已督促）：只在扩展内部做决策。
- 桌面端全部状态：运行中、待送达队列、弹窗、外观。
- 每个任务的工具次数、模型请求次数：D-L3 从 RPC 事件里数，只给界面。
- 子 agent 实时树：`src/domain.ts:503` 的 `parseChild` 解析 `subagent` 的 partial result，只给 L4。
- API 凭据：Pi 自己解析 `auth.json`，桌面端不转发。

这就是“界面通道和上下文通道分离”。

### 3.3 两种策略

- TillDone **从不改 system prompt**。规矩全部通过“工具说明 + 工具结果 + 自定义消息”送进去。所以它对 Pi 升级和别的扩展改 system prompt 都不敏感。
- PStack 在每次请求时**改 system prompt**，并在首条消息里展开整份技能。
- `subagent` 本身是上下文隔离：子进程带 `--no-session`，完整过程留在子进程里，父上下文只拿结论。这是 Delegation。

### 3.4 提示词的三个时机（TillDone）

| 时机 | 文本 | 目的 |
|---|---|---|
| 事前（每次请求都在） | 工具说明 | 告诉模型规矩和建议 |
| 事中（触发规矩时） | 门禁理由、`SPLIT_CUE`、15 次提示、确认被拒 | 在决策点给出可执行的下一步 |
| 事后（run 结束时） | 督促消息，列出未完成任务 | 防止半途收工 |

“错误即提示词”：门禁不在 system prompt 里写“请先建清单”。它在模型真的越过规矩的那一刻，用工具错误告诉它下一步调什么。例如 `GATE_REASON.noTasks`：

> 🚫 No TillDone tasks defined. You MUST use `tilldone new-list` or `tilldone add` to define your tasks before changing anything (bash, edit, write, subagent); every other tool stays available for planning. Plan your work first!

### 3.5 抗压缩

两者都把状态放在会话文件里，不依赖对话记忆。

- TillDone：`session_start` / `session_tree` 时，从会话分支里最后一个有效的 tilldone `details` 恢复清单（`state.ts:181` `restore`）。`parseDetails`（`state.ts:168`）把读到的快照当不可信数据逐字段校验。
- PStack：从 `pstack-todo` 和 mode 两类 custom entry 恢复（`pstack/index.ts:250-262`）。

## 4. 第 3 层：TillDone 的拆分能力

TillDone 只提供拆分的**时机**和**账本**。怎么拆由模型决定。

### 4.1 数据形状

```ts
interface Task { id: number; text: string; status: "idle" | "inprogress" | "done"; from?: number }
interface Model { list: ListState; nudged: boolean; spent: number }
```

九个动作：`new-list`、`add`、`start`、`done`、`remove`、`update`、`list`、`clear`、`split`。

### 4.2 split 动作（`state.ts:345-356`）

- 参数：`id` + `texts[]`（至少 2 个）。
- 把原任务**原位替换**成子任务，子任务带 `from = 原 id`，id 从 `nextId` 起编。
- 第一个子任务继承原状态；其余为 `idle`。所以拆分进行中的任务后，仍然只有一个任务在进行（“一次只赶一只羊”）。
- 已完成的任务不能拆：“Use add for new work instead of splitting it.”
- 当前任务 id 变了，`spent` 清零（`state.ts` 的 `ok()`）。所以拆分后的第一个子任务从 0 开始计数。

### 4.3 三个触发点 + 一个人的入口

1. **工具说明里的原则**（每次请求都在）：“Keep each task small enough to finish and verify in one focused change. If a task turns out bigger, split it instead of letting it grow; if you find work outside the current task, add it as a new task.”
2. **刚认领时** `SPLIT_CUE`（`state.ts:114`），附在 `start` 结果末尾：“Before you start: if this task holds two or more steps you can verify separately, split it now with `tilldone split`.” 理由：这是模型对任务大小了解最多、还没花任何成本的时刻。
3. **做了很久时**（`SPLIT_HINT_EVERY = 15`，`state.ts:117`）。`toolCalled`（`state.ts:431`）给当前任务的每个非 tilldone 工具调用 `spent + 1`；到 15 的倍数时生成提示：“💡 TillDone: task #N has taken 15 tool calls so far. If it is bigger than one step, split it with `tilldone split` (id=N) and keep going.” 提示在 `tool_call` 时决定，暂存在 `toolCallId` → hint 的 Map 里，等这次调用的 `tool_result` 回来再追加到结果末尾。模型不需要额外的 turn。
4. **人的入口：细分按钮**（`src/domain.ts:381-387`）。任务面板上每个未完成任务有“细分”按钮。点下后桌面端发一句“请把 #N 拆小”（空闲发 `prompt`，运行中发 `steer`），按钮变成“细分中…”。注释：“The shepherd points at a task; the model, which has the context, decides the subtasks.” 桌面端自己不拆，也不调 `split`。按钮在下次 tilldone 结果里该任务不再未完成时恢复，或者在 settle 结束时恢复（覆盖“模型决定不拆”）。

### 4.4 门禁与督促

- 门禁 `gate`（`state.ts:379`）：只拦 `GATED_TOOLS = ["bash", "edit", "write", "subagent"]`（`state.ts:377`）。依次检查：清单为空 → `noTasks`；全部完成 → `allDone`；没有 `inprogress` → `noneActive`。
- 桌面副本的门禁是**反转**过的（提交 `7437421`）。TUI 原版只放行 `tilldone` 和只读工具 `read/grep/find/ls`，其他全拦。原版不认识别的扩展加的工具：2026-11-01 Blackjack 运行里，`pstack_todo` 在 Poteto 会话开头被拦了 5 次，每次多一个来回。门禁是工作纪律，不是安全边界，所以副本改成只拦会改东西的工具。
- 督促 `agentEnd`（`state.ts:451`）：有未完成任务且 `nudged` 为假 → 返回 `tilldone-nudge` 消息，`nudged` 置真。L2 用 `sendMessage(nudge, { triggerTurn: true })` 发出。因为 `agent_end` 时 run 仍算活跃，消息进 steering 队列，settle 外循环再起一个 run。`input` 事件复位闩锁。每条用户输入最多督促一次：被督促后模型仍停下，说明可能真卡住了，该交还给人。

## 5. 第 3 层：PStack 带来什么

PStack（npm `pi-pstack`）在 Pi 里注册：

| 名称 | 类型 | 作用 |
|---|---|---|
| `/poteto-mode`、`/setup-pstack` | 命令 | 开关 Poteto Mode；交互配置角色 → 模型 |
| `input` 钩子 | 事件 | 看到 `/skill:poteto-mode` 开头的输入就开启 mode，并写 custom entry |
| `before_agent_start` 钩子 | 事件 | mode 开启时追加 system prompt |
| `tool_call` 钩子 | 事件 | 对部署、递归删除等外部写操作的 bash 命令要求确认 |
| `pstack_todo` | 工具 | `get/set/add/complete` 一份字符串清单；写 custom entry `pstack-todo` |
| `pstack_sessions` | 工具 | 列当前工作目录的会话文件 |
| `pstack_config` | 工具 | 读写 `<agent dir>/pstack/models.json` 的角色 → 模型映射 |
| `subagent` | 工具 | 单个 / 并行（有上限）/ 链式分派子 agent |

`poteto-mode/SKILL.md` 的要求：

> Start every multi-step task with `pstack_todo`; its first item is to read the Principles section below in full.
> Your first `pstack_todo` actions are the matched playbook's steps, copied in verbatim, before any task-specific todos and before you reason about the task.

子 agent 的命令行（`pstack/index.ts:145-148`）：

```text
pi --mode json --print --no-session --append-system-prompt <agent 提示文件> [--model <m>] [--tools <列表>] "Delegated task:\n<task>"
```

注意：子进程**不加载 tilldone**，命令行里也没有 `--no-extensions`。

桌面端怎样开启 Poteto Mode（`src/domain.ts:397-404`）：`TILLDONE_PSTACK=1` 时，会话的第一条空闲 prompt 被改写成 `/skill:poteto-mode <你的话>`。pstack 的 `input` 钩子开启 mode，之后的消息照原样发送。用 `/skill:` 而不用 `/poteto-mode`，是因为后者在 RPC 下失败（`ctx.sendUserMessage is not a function`，pstack 的 bug）。

## 6. 两者怎么分工、怎么咬合

### 6.1 分工对照

| 维度 | TillDone（`tilldone`） | PStack（`pstack_todo` + `subagent`） |
|---|---|---|
| 清单里装什么 | 工作项（羊） | 流程步骤（playbook 的步骤，逐字抄） |
| 谁看得见 | 任务面板、门禁、督促都靠它 | 只有模型（和工具卡片） |
| 约束力 | 硬：`bash/edit/write/subagent` 必须有进行中的任务；没做完催一次 | 软：只有提示词，没有门禁、没有督促 |
| 怎么“拆” | `split` 把任务拆成更小的任务 | 不拆任务；把一个任务**分派**给子 agent（并行或链式） |
| 持久化 | 工具结果里的 `details` 快照 | custom entry |
| 改 system prompt | 从不 | 每次请求追加一段 |

README 的说法：“In Poteto Mode the model keeps two lists: `pstack_todo` for pstack's process steps … and `tilldone` for the work items shown in the task panel. Only `tilldone` drives the panel, the gate, and the nudge.”

### 6.2 一次 Poteto 会话里的咬合时序

1. 首条消息被桌面端改写成 `/skill:poteto-mode <你的话>`；pstack 的 `input` 钩子开启 mode；Pi 把 SKILL.md 展开进这条消息。
2. 模型按 SKILL 先调 `pstack_todo set`，抄入 playbook 步骤。反转后的门禁放行（`pstack_todo` 不在 `GATED_TOOLS` 里）。
3. 模型用 `read` 读 playbook 和原则。`read` 不受门禁限制。
4. 真正动手前，模型必须 `tilldone new-list/add` 再 `start`。`start` 结果带 `SPLIT_CUE`，模型在这里决定工作项的粒度。
5. 任务进行中，模型可以调 `subagent`。它先过计费门 `billingGate`（拒绝 `anthropic/*`，并查 `models.json` 里的角色映射），再过 tilldone 门禁（必须有进行中的任务）。
6. 收尾：`tilldone done` 和 `pstack_todo complete`。`agent_end` 的督促**只看 tilldone 清单**。

### 6.3 代码里只有三个接缝

1. **反转的门禁**（`state.ts:377`）：让 pstack 的工具能通过，只把 `subagent` 算作“会改东西”的工具。
2. **计费门**（`state.ts:423` `billingGate`，`index.ts` 的 `tool_call` 里先于门禁执行）：检查 `subagent` 的显式 `model`、tasks/chain 里的 `model`、`role` 查到的模型，以及 `pstack_config set`。原因：用户的 Anthropic API 按量计费、没有充值。
3. **子 agent 进度显示**（`src/domain.ts:503` `parseChild`）：桌面 D-L3 解析 `subagent` 的 partial result，显示实时子 agent 树。只给界面。

除此之外两边互不认识：`state.ts` 只在计费部分提到 pstack；pi-pstack 的 `SKILL.md` 完全没有提到 tilldone（grep 结果）。

### 6.4 判断：“大脑 / 手脚”之说只对一半

讨论稿 `discussions/2026-11-01-traing-agent-tilldone-pstack-claudetraingskills.md` 说：“Tilldone 是大脑：管任务拆解和分工。PStack 是手脚：管任务的落实和执行。”

按代码看：

- TillDone 自己不拆。它是**账本 + 闸门 + 督促**。拆的决定由模型在它给的时机上做出。
- PStack 也不只是手脚。它带着自己的计划清单（playbook 步骤），还有另一种“拆”：分派给子 agent。
- 更准确的说法：TillDone 管“做什么、做完没”，用硬约束守住；PStack 管“怎么做”，只靠提示词引导。
- “两份清单各管什么”只写在 README 一行里，模型看不到。现在的“有机结合”是模型每次自己摸索出来的，不是设计保证的（推断，依据是 6.3 的 grep）。

## 7. 坑与开放问题

1. **子 agent 不受 TillDone 管。** 子进程不加载 tilldone。一次 `subagent` 调用在 `spent` 里只算 1 次；子 agent 内部做了多少工作，15 次提示和面板计数都看不到。分派出去的大任务看起来很“便宜”，不会触发拆分提示。
2. **子进程很可能加载全局扩展。** 子命令行里没有 `--no-extensions`，`~/.pi/agent/extensions` 里的扩展大概会进子 agent（推断，没实际运行验证）。计费门只覆盖第一层：子 agent 再派的子 agent 不经过它（README 已说明）。
3. **督促不管 PStack 的流程步骤。** playbook 的“验证”步骤没打勾，但 tilldone 任务全做完了，模型照样可以停。
4. **两份清单可能重复或错位。** 模型可能把 playbook 步骤也抄进 tilldone，面板上出现“读原则”这类伪任务；也可能反过来。最小修正：在 `TOOL.description` 里加一句，说明 tilldone 只放工作项、流程步骤放 `pstack_todo`。这一步需要改代码，尚未做。
5. **白皮书过时。** 白皮书 0.1 节和第 3 章仍写桌面端只加载 tilldone；pstack、反转门禁、计费门、子 agent 树都没写。用户决定等设计固定后再更新。
6. **细分请求的语言随界面变化。** `splitRequest` 按界面语言取中文或英文，是一段模型可见文本（白皮书 8.5 / R6）。

## 8. 代码在哪

| 文件 | 内容 |
|---|---|
| `apps/tilldone/extensions/tilldone/state.ts` | E-L3：门禁、计费门、拆分提示、督促、所有模型可见文案 |
| `apps/tilldone/extensions/tilldone/index.ts` | E-L2：挂 `tool_call`、`tool_result`、`agent_end`、`input`、`session_start`；注册 `tilldone` 工具（串行执行） |
| `apps/tilldone/src/domain.ts` | D-L3：RPC 投影 `reduce`、意图 `planIntent`、Poteto 前缀、细分按钮、子 agent 树、`toViewModel` |
| `apps/tilldone/src/config.ts` | 拼子进程命令行；处理 `TILLDONE_PSTACK`、拒绝 `anthropic/*` |
| `apps/tilldone/src/desk.ts` | D-L2：唯一可变状态，`this.state = reduce(this.state, record)` |
| `.pi/npm/node_modules/pi-pstack/extensions/pstack/index.ts` | pstack：`pstack_todo`、`subagent`、system prompt 注入、bash 确认 |
| `.pi/npm/node_modules/pi-pstack/skills/poteto-mode/SKILL.md` | Poteto Mode 技能全文 |
| `apps/tilldone/README.md` | 运行、配置、门禁、pstack、RPC 细节 |
| `apps/tilldone/docs/tilldone-desk-whitepaper.md` | 白皮书 v1.0（不含 pstack） |
| `discussions/2026-10-28-four-layer-harness.md` | 四层定义与 L3 原则 |
