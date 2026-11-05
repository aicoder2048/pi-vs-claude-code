# 弈境代码现状勘误（对照白皮书 v1.0）

> 整理：课程作者（Claude Code），2026-11-04。
> 代码快照：`apps/five-llm` 最后一次改动是提交 `4f65e37`（仓库 HEAD `01a9921`）。
> 验证：`bun test tests/*.test.ts` 为 121 项通过、0 失败（13 个文件）。白皮书写的是 74 项。
> 用法：白皮书与本文冲突时，以本文为准。本文没提到的部分，白皮书仍然有效。

## 1. 白皮书写于哪一版

白皮书 v1.0 写于 2026-10-30，描述的是提交 `380cb07`（L3 知识层重构）的状态。之后有 5 个提交改了行为：

| 提交 | 改了什么 |
|---|---|
| `df79ac8` | 最新一手加青色光晕，棋盘下方加说明文字（`renderer/app.ts`） |
| `642481a` | L3 v2：新增 `business/forcing.ts` 和工具 `check_forcing_sequences`；中盘提交前要求对手连续冲四反证，没做时 `place_stone` 返回 `needsReview`，不落子；知识包升到 v2 |
| `57f9fe8` | 人类赢一局时放彩纸，加一段短音（`renderer/celebration.ts`、`renderer/audio.ts`） |
| `17adc54` | 机器赢一局时改为“墨雨”效果，加一段下行音 |
| `745fd6c` | L3 v3：新增 `findOwnForcingWin` 和工具 `find_forcing_win`；观察时自动搜己方强杀；漏胜反馈门禁；知识包升到 v3 |

`4f65e37` 只改文档用词（PyAgent 改成 Pi）。

## 2. 与白皮书一致的部分

- 四层映射不变。L1 = `src/agent/*`，L2 = `src/extensions/gomoku.ts`，L3 = `src/business/**`，L4 = `src/electron/*` + `src/renderer/*`。L3 不 import Pi 或 Electron。`TurnPort` 与 `AgentDriver` 在 `game-service.ts:8`、`:14`。
- Pi SDK 用法不变（`pi-driver.ts`）：
  - `SettingsManager.inMemory` 关闭压缩、`retry.maxRetries: 1`、`cacheWarming: 'off'`（`:42-45`）。
  - `DefaultResourceLoader` 设 `noExtensions / noSkills / noPromptTemplates / noThemes / noContextFiles`，扩展经 `extensionFactories` 内联传入，`systemPrompt` 整段替换，`appendSystemPromptOverride: () => []`（`:46-54`）。
  - 先 `reload()`，再 `createAgentSession({ thinkingLevel: 'low', tools: GAME_TOOLS, noTools: 'builtin', sessionManager: SessionManager.inMemory(...) })`（`:58-62`）。
  - 工具隔离校验（`:64-67`）。
  - `session.subscribe`：第 9 次 `turn_start` 就 `abort()`；`tool_execution_end` 看到 `place_stone` 成功也 `abort()`（`:68-81`）。
  - `finally` 里 `dispose()`（`:97`）。每手一个内存 Session，只调一次 `prompt()`。
- 三道闸不变：请求上限 8、工具调用上限 16（`gomoku.ts:82` 附近）、技术超时 90 秒，取消经 `port.signal`。
- 路由优先级不变：time-pressure（≤ 15 秒）> endgame（任一方有立即成五点）> opening（不足 8 手）> midgame（`decision.ts:99-116`）。
- `RULESET` 仍是 `free-gomoku/v1`，无禁手。`validateCandidate` 仍只扫一步（`scope: one-ply-only`）。
- `valid()` 仍校验五个条件（`game-service.ts:170`）。内存日志仍只留 80 条（`:39`）。
- L4：preload 仍只暴露 4 个方法，通道 `five:bootstrap / five:command / five:export / five:state`（`preload.ts:4-10`）。`trusted` / `validCommand` 在 `main.ts:40`、`:43`；`PiDriver` 在 `:67` 创建；200 ms 心跳在 `:149`；退出时最多等 3 秒写盘。渲染端只有棋钟变化时只重画棋钟。
- `DecisionTrace` 仍然没有在界面上显示。

## 3. 白皮书过时或缺失的部分

### 3.1 工具：6 个变成 8 个

`gomoku.ts:11` 的 `GAME_TOOLS`：

`analyze_position`、`evaluate_threats`、`validate_move`、`read_knowledge`、`simulate_moves`、**`check_forcing_sequences`**、**`find_forcing_win`**、`place_stone`。

- `check_forcing_sequences(x, y, revision, 可选预算)`：只读。检查落下候选后，对手能否靠连续冲四强制获胜。结果是 `found-forced-loss`（有 proof）、`not-found-within-budget`（不等于安全）或 `incomplete`。
- `find_forcing_win(revision, 可选预算)`：只读。搜索当前行棋方自己的连续冲四胜法。找到时返回 `winningCandidate` 和 `proof`。
- 两者的工具预算：`maxAttackMoves` 1–4、`maxNodes` ≤ 6000、`maxMs` ≤ 200。默认 3 / 6000 / 200（`forcing.ts:6`）。业务函数硬上限 20000 节点 / 500 ms。时间紧迫时 `maxMs` 强制为 0，返回 `incomplete / clock-budget`。
- `place_stone` 仍只在 `accepted: true` 时返回 `terminate: true`（`gomoku.ts:242`）。

### 3.2 扩展事件：不止 `tool_call`

`gomoku.ts:26` 还挂了 `pi.on('turn_start', () => { modelTurn++; })`。L2 用这个序号判断：一条反馈是不是在**更早的**一次模型请求里返回的。白皮书 §3.4② 说 `tool_call` 是“唯一挂上的扩展事件”，§3.6 说“只用了 `tool_call` 一个”，现在都不对。

注意区分：L1 的 `PiDriver` 也订阅 `turn_start`，那是宿主的 `session.subscribe`，用来数请求、到第 9 次就 `abort()`。L2 的 `pi.on('turn_start')` 是扩展事件，用来给证据打请求序号。两者互不替代。

### 3.3 `place_stone` 的门禁变成多级（`gomoku.ts:188-242`）

1. 先要求本回合已经观察过局面（`analyze_position` 或 `evaluate_threats`）。
2. 判断是否需要审查（`:194`）：已下 ≥ 8 手、没有当前立即胜负、时间不紧迫。需要审查且还没自动搜过时，先搜一次己方强杀（来源 `pre-commit`）。
3. 已证明有己方强杀时：如果证明是本次请求才返回的，或者模型选了别的点又没带 `acknowledgeMissedWin: true`，就返回 `accepted: false, needsReview: true`，原因是 `unread-forced-win` 或 `missed-forced-win`。没有落子，回合不结束。
4. 没选证明起手时，还要对手反证：没做反证，或反证是本次请求才返回的，或结果是 `found-forced-loss` / `incomplete` 又没带 `acknowledgeRisk: true`，也返回 `needsReview`。
5. 通过后才真正 `port.commit()`，返回 `accepted: true` 与 `terminate: true`。

白皮书 §6.3 和 §7.2 第 8 条把 `needs_review` 写成“改进建议”。它已经实现了，但**只针对连续冲四**。`validateCandidate` 的一步警告仍然不阻止提交。

“本次请求才返回”的判断用的是请求序号：同一条模型回复里预先排好的“检查 + 提交”，不算模型已经读过反馈。

### 3.4 观察结果多了 `ownForcingWin`

普通中盘（≥ 8 手、无立即胜负、不紧迫）里，`analyze_position` / `evaluate_threats` 第一次观察会自动搜索己方强杀，结果附在 `ownForcingWin` 字段里（`gomoku.ts:52-57`、`:96`、`:108`）。同回合缓存，重复观察不重算。自动搜索不占工具调用预算，但照常计时。

### 3.5 信号契约

- 版本从 `gomoku-knowledge/v1` 变成 **`gomoku-knowledge/v3`**（`decision.ts:7`）。
- `facts` 新增 `terminal` 和 `next`。
- `time` 新增 `asOf` 和 `periodsLeft`。
- `priority` 的取值：`terminal` / `win-now` / `answer-immediate-threat` / `develop`。

### 3.6 `DecisionTrace`（`decision.ts:56-79`）

- 新增 `revision` 字段；`version` 兼容 v1 / v2 / v3。
- 新增可选的 `candidateReview`（版本 `candidate-review/v1`）：`candidate`、`simulations[]`、`forcingChecks[]`、`ownWinChecks[]`、`ownWinReview`、`declinedProvenWin`、`finalCandidateSimulationIds`、`finalCandidateCheckIds`、`forcingReview`、`coverage`。
- `coverage` 取值：`single-line-only` / `bounded-refutation` / `incomplete-refutation` / `own-forcing-proof` / `not-compared`。
- 试算证据现在是绑定候选的数组（`SimulationEvidence`），不再是覆盖式变量。白皮书 §4.5 第 1、2 条和 §7.2 第 9 条**部分修复**。但 `observed` 仍是覆盖式字符串（`gomoku.ts:95`）。
- `compare: done` 的条件改为：最终候选做过成功试算，或有已返回先前请求的完整有界反证，或选的就是已证明的强杀起手。
- 仍未修复：`knowledgeRead` 混合注入与主动读取；失败、取消、超时的回合不留记录。

### 3.7 知识包

- 条目从 13 个变成 **15 个**：入口 1 + 原则 5 + 剧本 4 + 技能 5。新增技能 `check-forcing-sequences`、`find-forcing-win`（`decision.ts:8-24`）。
- 入口 `SKILL.md` 的 compare / commit 步骤改写，加入 `ownForcingWin` 和两个确认参数。
- 白皮书 §4.2 的目录树、“13 个条目”、§6.4 的“默认注入约 2.1k 字符，全量约 4.8k”都过时。课程作者在快照上实测 `knowledgeContext(playbook)` 的长度：opening 2685、midgame 3535、endgame 2761、time-pressure 2779 字符；15 个条目全文合计 9707 字符。

### 3.8 L4 新功能（白皮书 §5.5 没写）

- 最新一手的青色光晕和说明文字。
- 胜负庆祝（`celebration.ts`）：只有一局刚刚结束时触发；开局加载、回看、心跳推送不触发；平局不触发。人类赢一局放 150 片彩纸，赢下整场 220 片；机器赢一局放 70 滴墨雨，赢下整场 110 滴。
- 结束音效：人类赢是上行琶音，机器赢是下行乐句（`audio.ts`）。背景音乐是本地两首 mp3。
- 关窗口即退出；macOS 额外绑定 Ctrl+Q。

### 3.9 行号漂移

白皮书附录 A 中 `gomoku.ts`、`decision.ts`、`app.ts` 的行号已过时。`pi-driver.ts` 与 `main.ts` 基本对得上。

## 4. 测试

| 文件 | 测什么 | 项数 |
|---|---|---|
| `pi-integration` | 真实 Pi 循环 + 本地 OpenAI 兼容 SSE 替身（127.0.0.1，不调用真实 API） | 27 |
| `clock-match` | 读秒、超时裁决、多局制 | 22 |
| `engine` | 规则与计算 | 12 |
| `forcing` | 有界连续冲四反证 | 12 |
| `decision` | 事实与启发式分离、路由 | 11 |
| `service` | `GameService` 权威性 | 9 |
| `audio` | 结束音效、背景音乐 | 9 |
| `missed-win-case` | 回归：G10 局面白方漏掉强杀 | 7 |
| `own-forcing` | 己方强杀搜索 | 7 |
| `model-selection` | 默认模型选择 | 7 |
| `celebration` | 庆祝触发条件 | 6 |
| `knowledge` | 知识包 | 5 |
| `forcing-case` | 10-30 人类胜局的复盘用例（H7 反证） | 1 |

`tests/smoke.ts` 是 Playwright 驱动的 Electron 冒烟测试，不在 `bun test` 范围内，本次没有运行。

## 5. 关键数字

| 项目 | 当前值 |
|---|---|
| 工具 | 8 个 |
| 知识条目 | 15 个 |
| 每回合 LLM 请求上限 | 8 |
| 每回合工具调用上限 | 16 |
| 技术超时 | 90 秒 |
| 重试 | 1 次 |
| 时间紧迫阈值 | 距丢失当前时段 ≤ 15 秒 |
| 开局阈值 / 中盘审查阈值 | 8 手 |
| 连续冲四默认预算 | 3 次造四延伸 / 6000 节点 / 200 ms |
| 心跳 | 200 ms |
| 日志 | 内存 80 条，界面显示 24 条 |
| 退出等写盘 | 3 秒 |
| 公开理由 `reason` | ≤ 600 字符 |
| 测试 | 121 项 |
| 知识包版本 | `gomoku-knowledge/v3` |
| Pi | 1.4.0（`@earendil-works/pi-coding-agent`） |
| 默认模型 | `gpt-6.1-sol`（`model-selection.ts:3`） |
