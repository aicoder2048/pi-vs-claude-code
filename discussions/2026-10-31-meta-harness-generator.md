# 讨论记录：元 Harness 生成器（“Meta啥”）的定位与形态

- **日期**：2026-10-31
- **参与**：Sean、Claude Code（Opus 5.5）
- **用途**：记录 Sean 对“元啥”的要求，以及对三个项目（边牧 TillDone、弈境 five-llm、楚河 chinese-chess）的回顾、归纳和形态建议。后续“反向抽取模板”的工作以本文为规格依据。
- **仓库内参考**：
  - `discussions/2026-10-28-four-layer-harness.md`（四层架构定义，与 Zoe 的讨论）
  - `discussions/2026-10-30-pstack-analysis-grok.md`、`discussions/2026-10-30-refactor-five-llm-pstack-grok.md`
  - `apps/chinese-chess/docs/chinese-chess-whitepaper.md`（5.9–5.11、9.2 节）
  - `apps/five-llm/docs/five-llm-whitepaper.md`、`apps/tilldone/docs/tilldone-desk-whitepaper.md`

---

## 1. Sean 的要求

1. 扫描所有对话（Claude Code，以及 TillDone / Pi / Pi SDK + gpt-6.1-sol），分析过程，归纳 TillDone、five-llm、chinese-chess 三个项目。
2. 在此基础上做一个“元啥”（Meta啥）：它能为某个指定的专家领域，**生成一个自定义的四层 Pi Agent Harness，界面用 Electron**。
3. 生成的 harness 的**第三层要像 pstack 一样**：系统、结构化、完整、可信（有 verification）、能自我改进。
4. 形态问题：它是一个还是一组 Claude Code 技能？还是一份可以被外部工具读入的提示词 / 提示词模板（类似和 Zoe 的讨论稿）？
5. 运行载体：Sean 倾向于**用 TillDone 加载“元啥”，由 TillDone 生成 Pi Custom Agent Harness**；以后可能给 TillDone 加 Loop 功能（还没想好）。同时承认 Claude Code 可能更现实。

---

## 2. 扫描范围和限制

| 来源 | 范围 | 说明 |
|---|---|---|
| Claude Code 会话 | 本仓库及 `apps/chinese-chess`、`apps/tilldone` 子目录，共 17 个会话（10-27 至 11-01） | 抽取了全部用户消息 |
| 仓库文档 | `discussions/` 8 份、三份白皮书、git log（86 个提交） | |
| TillDone 的对话 | **无法扫描** | `apps/tilldone/src/rpc.ts` 启动 Pi 时带 `--no-session`，对话从未落盘 |
| five-llm / chinese-chess 首版 | **不在这些 Claude Code 会话里** | git 中只有 10-29 “Add 弈境”“Add 楚河”两个提交；Claude Code 里做的是审查、pstack 式重构、白皮书、实战复盘修 bug、性能检查、打 DMG |
| “toolbuild” | 记录中没有找到这个词 | 暂按“读入提示词工作的外部工具”理解 |

---

## 3. 三个项目的归纳

| | 边牧 TillDone | 弈境 five-llm | 楚河 chinese-chess |
|---|---|---|---|
| L1 接入 | 原生 Pi，RPC 子进程 | Pi SDK | Pi SDK |
| L2 | `tool_call` 门、`agent_end` 催办（`triggerTurn`）、工具串行执行（`executionMode: "sequential"`） | 3 个工具、TurnPort | 9 成员 TurnPort；闸门（8+2 请求预算、搜索、棋钟、取消）、调用审计 |
| L3 | 任务状态机（纯函数） | 确定性引擎 + 5 原则 / 4 剧本 / 5 技能 | 专家计算服务 + 19 项 Pi 原生技能 + 宿主路由 + `DecisionTrace` v2 + 赛后学习 Worker |
| L4 | Electron 桌面 | Electron 棋盘 | Electron 棋盘 + 学习界面 |
| 验证 | fake-pi 测试替身 | 本地 SSE 测试替身驱动真实 Pi Agent Loop | 同左 + 提交时独立审查 |

### 3.1 反复出现的工作流程

每个项目都走了同一条流程，它本身就是方法论：

> 与外部模型讨论（Zoe / Grok）→ 讨论稿 → 实现 → poteto-mode 审查与重构 → 白皮书 → 实战复盘发现 bug → 修复 → 同步白皮书（含精简版）

### 3.2 反复出现的不变量

- 计费边界：拒绝 `anthropic/*`，默认 `openai-codex/*`。
- L4 界面通道与上下文通道分离；冲突时以界面为准。
- 每个进入上下文的字段，都要回答“它帮模型做哪个业务决策”。
- 状态存文件，不依赖对话记忆。
- Ctrl+Q / 关窗干净退出；每个 app 有 `just <name>` 配方。
- 测试替身驱动真实 Pi 循环，不消耗 API 额度。

---

## 4. 形态判断：模板仓库 + 一组技能 + 一份规格

**结论：既不是单个技能，也不是单份提示词。三样缺一不可。**

| 组成 | 内容 | 为什么需要 |
|---|---|---|
| 模板仓库（骨架代码） | 从三个 app 抽出的可运行骨架：Pi 接入（RPC / SDK）、计费守卫、本地 SSE 测试替身、视图推送的序号与去抖、子进程干净退出、just 配方、DMG 打包 | 最难的部分在代码层，不在描述层。每次从零生成都会重新踩坑（例如楚河第 33 手事故：8 次请求全部用于分析时回合直接失败） |
| 一组技能（pstack 形状） | 编排入口：领域访谈 → 领域规格 → 套骨架 → 填 L3 → 验证 → 出白皮书；每阶段一个剧本；不变量做成原则；一个验证技能 | 整件事分阶段，每阶段验收标准不同 |
| 一份规格 | “领域简报”问卷（确定性计算有哪些、知识有哪些、决策点、什么算对、什么算危险动作）+ 四层契约文档 | 相当于和 Zoe 那份讨论稿的升级版 |

### 4.1 第三层“像 pstack”的准确含义

楚河白皮书 5.9 节的结论：借用 pstack“原则索引 → 编排 → 剧本 → 技能 → 证据 → 验证”的骨架，但把**路由权、验证时机和状态所有权收回到宿主**。元啥生成的 L3 应沿用这个修正，不照搬 pstack 由模型自选剧本的做法。

- **可信（verification）**：确定性专家计算 + 提交时复查 + “错误即提示词”的反驳回路。弈境和楚河已经验证可行，可直接进模板。
- **自我改进**：楚河的数据级学习环已自动闭合；知识文本的改进环没有闭合（白皮书 9.2 第 9 条）。因此元啥**除了生成 harness，还必须生成评测器**：读回对局 / 运行记录的分析器，加一套情景回归集。从证据到修改 SKILL.md 这一步保留人工审阅（提示词漂移、对单一模型过拟合的风险高于收益）。

---

## 5. 运行载体：先 Claude Code，后 TillDone

**建议：先在 Claude Code 里做出来并验证，再迁到 TillDone。** 技能一开始就按 Agent Skills 标准（SKILL.md）写，Pi 和 Claude Code 都能原生加载，写一份两边用。

### 5.1 TillDone 目前缺什么

| 缺口 | 现状 |
|---|---|
| 不能加载技能 | `rpc.ts` 启动参数写死 `--no-skills` |
| 不能恢复会话 | `--no-session`；生成一个四层应用要跑数小时，中途断了只能从头来 |
| 单一模型 | 没有子 Agent，也没有多模型交叉审查 |
| 没有 Loop | 还没想好 |

### 5.2 TillDone 的天然优势

TillDone 的 L2 `tool_call` 门可以强制**“完成必须有证据”**：任务不能直接标为 done，必须 `bun test` / smoke 通过后才放行。这正是元啥需要的验证机制，Claude Code 没有现成对应物。

### 5.3 给 TillDone 补能力的建议顺序

1. 会话持久化与恢复
2. 允许加载指定的技能目录
3. 完成门挂验证命令
4. Loop

---

## 6. 下一步

| 步骤 | 内容 | 验收 |
|---|---|---|
| 1. 反向抽取 | 从三个 app 抽出骨架仓库、四层契约、领域简报问卷、L3 技能组脚手架（原则 / 剧本 / 技能 / 验证 / 评测）。不写新功能 | 骨架能独立跑起来，测试替身测试通过 |
| 2. 新领域验证 | 用 Claude Code 驱动元啥，生成一个非棋类领域的 harness。候选：IdiomSolitairePiHarness（成语接龙，简单，建议先做）、OptionTradingPiHarness（期权，真实需求） | 生成结果通过同一套测试替身，能套用同一份白皮书模板 |
| 3. 迁到 TillDone | 按 5.3 补能力后，让 TillDone 加载同一组技能，重跑成语接龙 | 与第 2 步结果对比 |

---

## 7. 未决问题

1. 元啥的名字。
2. 骨架里 Pi 接入默认选 RPC 子进程还是 SDK（TillDone 用 RPC，两个棋类用 SDK）；还是两种都提供，由领域简报决定。
3. 评测器的通用形态：棋类有对局记录，非棋类领域的“记录”和“回归情景”长什么样。
4. “toolbuild”具体指什么工具，是否需要一份面向它的提示词版本。
5. TillDone 的 Loop 功能定位。
