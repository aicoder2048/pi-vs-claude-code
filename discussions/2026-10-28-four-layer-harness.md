# 讨论记录：用扩展搭自定义 Pi Agent Harness 的四层架构

- **日期**：2026-10-28
- **参与**：Sean、Zoe（PyAgent Harness 四层分析的作者）、Grok（tilldone 四层拆解）
- **用途**：作为后续开发规格（dev spec）的参考依据。第 2–6 节整理讨论结论；第 7 节对照 Pi 1.4.0 源码和本仓库的走读做了核对，写 spec 时以第 7 节为准。
- **外部参考**：IndyDevDan，*The Pi Coding Agent: The ONLY REAL Claude Code COMPETITOR*（YouTube，2026-02-23）<https://www.youtube.com/watch?v=f8cfH5XX-XU>
- **仓库内参考**：
  - 走读目录 `walkthroughs/index.html`。
  - 阅读指南 `walkthroughs/guide-loops.html`（双循环与回调点）、`walkthroughs/guide-turn.html`（一个 turn 内部的插入点）。

---

## 1. 讨论脉络

| 部分 | 内容 | 产出 |
|---|---|---|
| 一 | 把 Zoe 的 PyAgent Harness 四层架构，和 IndyDevDan 视频里的 Pi 扩展示例逐层对照 | 两边互相印证；发现 context 钩子应该承担“保护”职责 |
| 二 | Sean 补充：第三层的本质是业务语义，不是上下文管理 | 第三层的设计原则（第 3 节） |
| 三 | Sean 和 Grok 讨论 tilldone 扩展的四层拆分和物理结构 | tilldone 重构设计（第 6 节） |

---

## 2. 四层架构定义

| 层 | 名称 | 职责 | 不做什么 |
|---|---|---|---|
| L1 | Pi 运行时 | 搬运和累积：拼装上下文，把工具结果追加进历史 | 不判断内容好坏。历史会一直增长，除非 compaction 或扩展介入 |
| L2 | ExtensionAPI（回调注册） | 在 L1 的固定插入点上挂回调，是 L1 和 L3 之间的胶水 | 不放业务规则 |
| L3 | 业务逻辑（PyAgent 里是 Python） | 决定什么信息进上下文、进多少、以什么形式进 | 不碰渲染，也不直接依赖 Pi 的事件形状 |
| L4 | 界面 | HTML 图表、终端摘要、页脚 / widget：一条独立的数据通道 | 不占上下文，也不经过模型转述 |

讨论中最初列出的 L2 “五个插入点”：

1. `before_agent_start`：写系统提示词。
2. `registerTool`：写工具描述，并提供工具实现。
3. `input`：改写用户输入。
4. `context`：每次请求前裁剪或替换历史，被认为是最关键的一个。
5. `tool_call`：在工具执行前的决策点返回拦截理由。

完整的插入点清单见第 7.1 节。

**L4 的约定**：界面通道和上下文通道是分开的。两者冲突时以界面为准，因为界面数据直接来自 L3 状态，没有经过模型转述。

---

## 3. 第三层的原则：上下文管理是手段，业务语义是内容

> Sean 认可的框架，后续讨论和 spec 都沿用它。

第三层的边界问题，本质是：**什么信息值得让模型看到、看到多少、以什么形式。这个答案由业务语义决定，不由工程便利决定。**

- **摘要不是随便缩的。** 哪些字段对交易决策有用、哪些可以丢，背后是期权交易的领域知识。
- **风控结果、数据时效这些判断来自业务规则**，不是通用的裁剪逻辑。
- **结构化错误加“下一步建议”**，是在用业务语言教模型处理异常。
- 配套做法：
  - 完整数据留在缓存和 HTML（L4）里。
  - 给模型的是精简摘要，加上编号、时间、风控结果。
  - 状态存文件，不依赖对话记忆。

写 spec 时的检验标准：每一个进入上下文的字段都要能回答“这个字段帮模型做哪个业务决策”。答不上来的字段，不进上下文。

---

## 4. 和 IndyDevDan 视频的交叉对照

| 层 | 视频中的例子（本仓库对应的扩展） | 印证了什么 |
|---|---|---|
| L1 | 视频说 Pi 的系统提示词约 200 token，Claude Code 约 10,000+ | 运行时只搬运、不判断（token 数是视频的说法，本仓库没有核实） |
| L2 | Damage Control 用 `tool_call` 拦截 `rm -rf`；Purpose Gate 用 `before_agent_start` 追加系统提示词；Tool Counter 记录工具调用 | 插入点的实际用法 |
| L2 / L3 | Tilldone：任务没定义、没开始时拦下其他工具；没做完时催 agent 继续 | “保护”职责的实际案例（准确机制见 7.2） |
| L3 | Agent Chain 让每个子 agent 只返回精简结果；Meta Pi（pi-pi）决定调度哪个专家 | 控制进入上下文的信息量 |
| L4 | Pure Focus、页脚显示模型和上下文窗口、Subagent Widget 持续显示子 agent 状态 | 界面通道和上下文通道分离 |

**交叉结论**：两边互相印证，视频给 Zoe 的抽象分析提供了可以运行的例子。Zoe 的报告没覆盖、但视频强调的有三点：

1. 扩展可以叠加（`pi -e a.ts -e b.ts`）。
2. 可以用 meta-agent 来造 agent（pi-pi）。
3. 在 harness 层做专精，本身就可以成为护城河。

---

## 5. 设计缺口：context 钩子的“保护”职责

**问题**：如果 context 钩子只做裁剪，那么用户偏好、当前持仓摘要、等待确认的草稿这类内容，可能在裁剪或 compaction 后消失，模型就忘了。

**提案**：

1. context 钩子同时承担两件事：**裁剪**（去掉不需要的）和**保护**（确保受保护的内容每次请求都在）。
2. 在 L3 的 JSON 约定里加一个标记，让钩子能识别哪些内容受保护。字段名还没定，下面是一个例子：
   ```json
   { "kind": "position_summary", "protect": true, "as_of": "2026-10-28T14:30:00Z", "data": { "...": "..." } }
   ```
3. 受保护内容的**来源是 L3 的状态文件**，不是对话历史。钩子每次都从状态文件重新生成，而不是指望它还留在历史里（原因见 7.3）。

---

## 6. 案例：tilldone 四层重构设计

> 这一节原本是请 Zoe 单独写成 `refactor-tilldone-four-layer.md`。现在先收进这份记录，需要单独成文时可以直接拆出来。

### 6.1 背景

`extensions/tilldone.ts` 是 726 行的单文件，把 L2、L3、L4 混在一起：

- **L2**：`pi.on` 注册了 `session_start`、`session_switch`、`session_fork`、`session_tree`、`tool_call`、`agent_end`、`input`，还有 `registerTool` 和 `/tilldone` 命令。
- **L3**：`tasks` 数组、`makeDetails`、`reconstructState`，以及 add / toggle / remove / update / clear 这些操作。
- **L4**：`setFooter`、`setWidget`、`setStatus`，以及 `/tilldone` 命令的浮层。

唯一的外部依赖是 `themeMap.ts` 的 `applyExtensionDefaults`。

走读 `walkthroughs/tilldone.html` 里标出的问题：

| # | 问题 | 位置 | 后果 |
|---|---|---|---|
| B1 | `makeDetails` 是浅拷贝：`tasks: [...tasks]` 只复制了数组，task 对象还是同一个 | `tilldone.ts:168` | 之后的 toggle 会原地修改已经写进会话树的旧 details。用 `/tree` 回看历史时，看到的是“现在”的状态 |
| B2 | `setStatus` 参数写反：调用写成 `setStatus(文字, "tilldone")`，但签名是 `setStatus(key, text)` | `tilldone.ts:289/293` | 每次的文字都被当成一个新 key，状态条越积越多 |
| B3 | Pi 默认并行执行工具：同一批 tool call 会先全部过一遍 `tool_call` 门，再一起执行 | 门在 `tilldone.ts:335`；Pi 的逻辑在 `agent-loop.ts:518` | 同一批里有 `tilldone toggle` 和 `read` 时，`read` 被门拦下：门看到的是 toggle 执行前的状态 |

### 6.2 目标

- L3 是纯逻辑，可以单独做单元测试。
- L4 是纯渲染，只读状态。
- L2 只做胶水。
- 三层通过 `ctx` 和函数参数对接，互相不 import 对方的实现细节。
- L1（`vendor/pi`）不动。

### 6.3 物理结构

```
extensions/
├── tilldone/
│   ├── index.ts   # L2：pi.on 注册、registerTool、registerCommand，传递 ctx
│   ├── state.ts   # L3：tasks、nextId、makeDetails、reconstructState，以及 add/toggle/remove/update/clear 纯函数
│   └── ui.ts      # L4：footer、widget、status、/tilldone 浮层（TillDoneListComponent）
└── themeMap.ts    # 共享：applyExtensionDefaults（不变）
```

拆分后的接口约定（建议）：

- `state.ts` 不 import `@mariozechner/pi-coding-agent` 的运行时对象，只导出纯函数和类型，每个操作返回新状态和要写进会话的 details 快照。
- `ui.ts` 只接收状态和 `ctx.ui`，不修改状态。
- `index.ts` 是唯一同时知道 Pi 事件和 L3/L4 的地方。

拆成目录以后，justfile 里的 `-e extensions/tilldone.ts` 要改成新入口 `-e extensions/tilldone/index.ts`。

### 6.4 关键设计决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | `tool_call` 门用改写模式，返回 `{ block: true, reason }` | reason 会成为给模型看的错误结果，模型下一个 turn 能据此调整（见 guide-turn 第 9 行） |
| D2 | `tilldone` 工具设置 `executionMode: "sequential"` | 修 B3。只要同一批里有一个工具是 sequential，整批就改为串行，toggle 执行完后门才检查下一个工具（`agent-loop.ts:526–529`） |
| D3 | `nudgedThisCycle` 在 `input` 事件时清零；`agent_end` 催过之后设为 true | 保证用户提问一次，最多催一次，不会无限续跑 |
| D4 | 状态持久化：`makeDetails` 的快照写进会话树；恢复时沿 `getBranch` 读最后一条 tilldone 结果的 details | 状态跟着会话分支走，`/tree`、fork、切换会话时都能正确恢复 |
| D5 | `makeDetails` 改成深拷贝：`tasks.map(t => ({ ...t }))` | 修 B1。`Task` 只有 `id`、`text`、`status` 三个基本类型字段，一层展开就够 |
| D6 | `setStatus` 改成 `setStatus("tilldone", 文字)` | 修 B2 |
| D7 | `setFooter` 是“最后一个赢”：tilldone 会覆盖 minimal 和 theme-cycler 的页脚 | 已知限制，叠加扩展时要注意加载顺序 |
| D8 | `agent_end` 里调 `sendMessage(..., { triggerTurn: true })`，让外循环转第二圈 | 这是走读里第一次展示外循环续跑；催办靠的就是它 |

### 6.5 验收（建议）

- `state.ts` 的单元测试覆盖：
  - add / toggle / remove / update / clear 各自的正常路径和错误路径；
  - 深拷贝：之前生成的快照不受后续操作影响（B1）；
  - `reconstructState` 能从一串 details 正确恢复状态。
- 手工验证：
  - 同一批里 toggle 加 read 不再被拦（B3）；
  - 状态条只有一个 key（B2）；
  - 一次提问最多催一次。
- 行为和重构前保持一致，除 B1–B3 外不改变功能。

---

## 7. 核对备注（对照 Pi 1.4.0 源码和本仓库走读）

讨论里有几处说法和代码不完全一致，写 spec 时以这里为准。

### 7.1 扩展的插入点不止五个

按“能不能改变流程”来分（详见 `walkthroughs/guide-turn.html`）：

| 时机 | 插入点 | 方式 |
|---|---|---|
| 提问入口 | `input` | 改写输入，或返回 handled，让这次提问根本不开始 |
| 每次 settle 开头 | `before_agent_start` | 改系统提示词，只在本次 settle 内有效 |
| 每次请求前 | `context` | 改这一次请求的消息，不写回会话 |
| 发请求时 | `before_provider_request` | 改发给 provider 的原始请求体 |
| 工具执行前 | `tool_call` | 拦截 |
| 工具执行后 | `tool_result` | 改工具结果 |
| turn 结束 | `turn_end` | 要求再跑一个 turn |
| run 结束 | `agent_end` 加 `sendMessage({ triggerTurn })` | 让外循环再跑一个 run |
| 任何时候 | `sendMessage` 的 steer / followUp | 往队列里放消息，由 loop 在固定检查点取走 |
| 注册 | `registerTool`、`registerCommand`、`registerShortcut`、`registerFlag` | 不是钩子，是注册能力 |

`turn_start`、`message_*`、`tool_execution_*` 都**只能观察**，改不了流程。

### 7.2 视频对照里的几处更正

- **Tool Counter** 用的是 `tool_execution_end`，只能观察，没有用 `context` 钩子。
- **Tilldone 没有用 `context` 钩子。** 它的“保护”靠三样东西：
  - 状态存在会话树的 details 里（D4）；
  - `tool_call` 门：没有任务或没有进行中的任务时，拦下其他工具；
  - `agent_end` 催办（D8）。

  所以 tilldone 印证的是“保护”这个**需求**。用 context 钩子来做保护（第 5 节）仍然是**提案**：本仓库 18 个扩展都没有用到 context 钩子。
- **Pure Focus** 在本仓库的实现是用一个 `render` 返回 `[]` 的组件顶掉内置页脚，页脚和状态行都不显示了。视频里“只留一条进度条”的说法，和本仓库这份代码对不上。
- **系统提示词 200 vs 10,000+ token** 是视频的说法，本仓库没有核实。

### 7.3 context 钩子只影响单次请求，这对“保护”有直接影响

- `context` 钩子的返回值只用于这一次请求（`sdk.ts:428`），**不写回会话**。会话里存的历史不会因为它而变短。
- 自动 compaction 发生在每个 turn 开头的 `prepareNextTurn`（`agent-session.ts:898`），比 context 钩子更早。compaction 改写的是会话本身。
- 结论：
  - 受保护内容不能指望一直留在历史里。context 钩子要在**每次请求时从 L3 状态重新注入**。
  - 要让会话历史本身变短，靠的是 compaction，不是 context 钩子。
  - L1 “历史无限增长”这个说法，要加上“除非 compaction”。

### 7.4 和走读一致、可以直接引用的点

- `setFooter` 是“最后一个赢”：见 pure-focus 走读。
- `agent_end` 加 `triggerTurn` 让外循环续跑：见 tilldone 走读。
- `tool_call` 的 block reason 会成为给模型看的 toolResult：见 damage-control、damage-control-continue 走读。
- B1、B2、B3 都已对照 `extensions/tilldone.ts` 源码确认。

---

## 8. 未决问题

1. 受保护内容的 JSON 标记：字段名、结构，以及有多条受保护内容时怎么排序、超出预算时怎么取舍。
2. 每次请求重新注入受保护内容，会不会破坏 prompt cache？注入的位置和顺序要固定。
3. tilldone 是否值得拆成目录？还是把它当成“四层拆分”的样板，以后的扩展都照这个结构写？
4. 叠加扩展时多个扩展抢页脚（D7）：要不要做一个共享的页脚组合器？
5. PyAgent 的 L3 是 Python，而 Pi 扩展是 TS：L2 和 L3 之间的进程边界、序列化格式还没定。
