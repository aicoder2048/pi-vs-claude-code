# 讨论记录：楚河（chinese-chess）L3 重构 —— 用 Pi 原生 Skill / Package 体系承载业务知识

- **日期**：2026-10-30
- **用途**：讨论稿，供 Sean 拍板后再写 dev spec。**只写文档，不改代码。**
- **对象**：`apps/chinese-chess`（工作区 HEAD `e15f2ee`，三次提交：`00478af` 首版、`f57a9db` 搜索 / 评价 / 计划、`e15f2ee` DMG）
- **前置文档**：
  - `discussions/2026-10-28-four-layer-harness.md`：L1–L4 定义与 L3 原则（本文术语来源）
  - `discussions/2026-10-30-pstack-analysis-grok.md`：pstack 技能组的结构分析
  - `discussions/2026-10-30-refactor-five-llm-pstack-grok.md`：five-llm 的 pstack 式改造提案（本文仿照的形态）
  - `apps/five-llm/docs/five-llm-whitepaper.md`、`apps/five-llm/docs/l3-knowledge-refactor.md`、提交 `380cb07`：five-llm 实际落地的 L3 拆分
- **Pi 版本**：`@earendil-works/pi-coding-agent` **1.4.0**（`apps/chinese-chess/node_modules/@earendil-works/pi-coding-agent`，下文简写为 `pi/`）

---

## 0. 阅读约定与证据等级

1. **层编号自下而上**：L1 Agent Loop（Pi SDK 驱动）、L2 Pi 扩展、L3 业务、L4 Electron 桌面。与 four-layer 讨论稿和 five-llm 白皮书一致。
2. **引用写作 `路径:行号`**，路径相对仓库根或 `apps/chinese-chess/`。Pi 的引用指 1.4.0 的 `docs/*.md`、`examples/sdk/*.ts` 和 `dist/**/*.js|d.ts` 编译产物。
3. **证据等级**：源码 / 文档 > 测试 > README 自述 > Grok 二手分析。凡 Pi 的 API 说法都有出处；查不到或没跑过的标注 **待验证**。
4. 本文不做棋力声明。five-llm 白皮书 4.7 节已经说明：单局对局不能把胜负归因到知识层。

---

## 1. 背景与目标

### 1.1 来历

five-llm 在 `380cb07` 完成了 L3 拆分：`engine.ts` 拆成 `rules.ts`（硬规则）/ `tactics.ts`（启发式）/ `decision.ts`（信号与路由），再加一个 **宿主自管的知识包**（13 个 Markdown 条目，`KNOWLEDGE_ITEMS` 白名单，`read_knowledge(id)` 工具）。Grok 的提案末句写明：这套做法先在 five-llm 试点，**下一个就是象棋 harness**。

但 five-llm 的知识包刻意绕开了 Pi 的技能机制：`noSkills: true`（`apps/five-llm/src/agent/pi-driver.ts:50`），加载、索引、路由全部自写（`knowledge-loader.ts` 20 行、`decision.ts:7-21` 的 `KNOWLEDGE_ITEMS`）。白皮书 4.2 节给的理由是：Pi 技能要靠 `read`/`bash` 读文件，而应用不开放文件系统工具；且不想让用户目录里的同名技能混进来。

这两条理由对楚河同样成立。但象棋的知识量比五子棋大一个量级（开局体系、中局战术、残局技术、规则细节、学习案例、搜索解读），如果继续自建一套"解析 frontmatter、校验、索引、按 ID 读取、命令展开"，等于把 Pi 已经写好的 `skills.js` 再写一遍。本文的任务是：**既保留 five-llm 的隔离与权威性，又尽量复用 Pi 的 Skill 系统**，并评估要不要用 Pi Package 打包。

### 1.2 目标

| # | 目标 | 可检验标准 |
|---|---|---|
| G1 | 业务知识文本（原则、剧本、技能、术语）从 TypeScript 字符串搬到 **Pi 格式的 SKILL.md**，由 Pi 的加载器发现和校验 | `resourceLoader.getSkills()` 返回的名字集合等于期望集合，`diagnostics` 为空；改 Markdown 不改代码 |
| G2 | **渐进披露**：常驻上下文只有入口 + 索引 + 一份当前剧本；其余按需读取 | 系统提示词字符数相对现状下降；测试断言默认只注入选中剧本 |
| G3 | **路由权在代码**：按局面（阶段、被将、威胁、棋钟）确定性地选剧本；模型只能在白名单里按需读 | 纯函数 `turnGuidance()` 有单元测试；`read_skill` 参数是 enum |
| G4 | **可审计**：每手记录注入了什么、读了什么、用了哪些工具 | `TurnNote` 新增版本化 `decision` 字段，随现有原子保存链路落盘 |
| G5 | **工具描述与系统提示词瘦身**，流程说明只有一份（在 skill 里） | 工具 `description` 只讲参数 / 返回；SYSTEM 常量只剩身份、坐标、硬约束 |

### 1.3 非目标

- 不改 `engine.ts` 规则、`clock.ts` 棋钟、`GameService` 的权威提交流程（它们是 L3 的"保险丝"，不是知识）。
- 不引入子 Agent、云库、外部引擎（`KNOWLEDGE-SOURCES.md` 已列为"已评估未接入"）。
- 不把定式写成 Markdown 让模型背：five-llm 白皮书 7.2 第 7 条的教训是"定式应做成确定性信号"，楚河的 `knowledge.ts` 已经是这样做的，要保留。
- 不声称棋力提升。

---

## 2. 现状盘点：楚河的四层怎么落地

### 2.1 总表

| 层 | 文件 | 职责 | 和 five-llm 的差异 |
|---|---|---|---|
| L1 | `src/agent/pi-driver.ts`（109 行）、`model-selection.ts` | 每个机器回合新建内存 Session；`noSkills/noExtensions/noContextFiles/noPromptTemplates` 全关（`pi-driver.ts:56`）；`noTools: 'builtin'` + 7 个工具（`:65-66`）；8 次请求预算（`:76`）；工具隔离校验（`:69-72`）；**无 90 秒超时**，只受棋钟约束 | 结构同源；多了 `port.search()` 的回合前自动搜索（`:82-89`） |
| L2 | `src/extensions/xiangqi.ts`（90 行） | 内联工厂 `xiangqiExtension(port)`；`tool_call` 预算闸 16（`:15-22`）；7 个工具：`analyze_position / search_position / review_move / compare_moves / simulate_moves / update_plan / move_piece`（`:9`） | 工具多一个，且 `move_piece` 是**异步**提交（`:85`，等待业务层最终搜索） |
| L3 | `src/business/`：`engine.ts` 规则与重放；`expert.ts` 子力 / 安全 / 原则 / 候选审查；`evaluation.ts` 位置项；`search.ts` + `live-search.ts` 有界搜索与预算；`plan.ts` 跨回合计划；`knowledge.ts` 12 条定式 + 条件棋理；`learning.ts` 赛后案例验证与召回；`game-service.ts` 权威状态、棋钟、`TurnPort`、提交复查；`src/learning/` Worker 与原子库 | 规模约为 five-llm L3 的 3 倍；多了搜索、计划、学习闭环三条线 |
| L4 | `src/electron/main.ts`、`preload.ts`、`src/renderer/*` | 组合根、200ms 心跳、IPC 白名单、原子保存、学习 Worker 调度、Canvas/SVG 棋盘、专家参谋面板、复盘面板 | 多了学习 Worker（`main.ts:89`）和搜索 Worker（`:91`） |

依赖方向与 five-llm 相同：L3 定义 `TurnPort` / `AgentDriver`（`game-service.ts:14-23`），L1 / L2 依赖 L3，反向 import 为零。

### 2.2 一手棋的流向（与 five-llm 的差别处）

1. `GameService.startAgent()`（`game-service.ts:195`）生成本回合 `TurnPort`：`state` 快照、`signal`、`recall`、`log`、`search`、`updatePlan`、`commit`。
2. `PiDriver.run()` 先跑一次**回合前自动全根搜索** `port.search()`（`pi-driver.ts:82-89`），结果写回 `snapshot.analysis.expert.search`。
3. 创建 Session，`session.prompt()` 发送用户提示词（`pi-driver.ts:91-100`）。
4. 模型在 run 内循环里调用工具；`move_piece` 调 `port.commit()`，业务层**独立**做 `reviewMove` + 最终搜索 + `mergeSearchReview`，风险超阈值且无 `riskAcknowledgement` 则抛 `MoveRiskError`（`game-service.ts:257-277`），错误文本带整个 review JSON 回到模型（`expert.ts:272`）。
5. 成功后 `terminate: true`（`xiangqi.ts:86`）；`TurnNote` 记录 `reason / review / plan / planUpdate / riskAcknowledgement`（`game-service.ts:281-284`）。

### 2.3 L3 里到底有哪些"知识"，现在各住在哪

按 five-llm 白皮书 4.1 节的四级可信度分类：

| 类别 | 内容 | 现在的载体 | 能否被模型看到 |
|---|---|---|---|
| **硬规则** | 走法、将帅安全、将死 / 困毙、重复、120 半回合、棋钟、revision、一次提交 | `engine.ts`、`clock.ts`、`game-service.ts`（代码） | 只通过错误文本间接看到 |
| **确定性事实** | 全部合法走法、每子的合法攻击者 / 几何保护者 / 牵制、子力、阵型、搜索主变化与覆盖 | `expert.ts:83-94` `inspectSafety`、`:192-199` `formation`、`search.ts` | 全量 JSON 进用户提示词（`pi-driver.ts:99`） |
| **启发式** | 候选分数、位置六项、阶段子力值、同格交换估计 | `expert.ts`、`evaluation.ts`、`live-search.ts` | 同上，带 `limitations` 字段 |
| **流程知识 / 专家经验（文本）** | 怎么读报告、先查什么、何时用哪个工具、计划协议、风险说明何时允许、开中残局要点、知识 / 案例字段怎么用 | **散在四处的 TS 字符串**：① `pi-driver.ts:10-24` SYSTEM 常量 15 行；② `xiangqi.ts:25,31,42,48,54,66,79` 七个工具的英文 description；③ `expert.ts:200-217` `knowledge()` 的 9 条原则 `advice` + `:258-262` 两条；④ `knowledge.ts:64-70` 四条条件棋理、`learning.ts:13-16` 动机文案、`:213` 召回建议 | 全部常驻或随结果出现 |
| **结构化领域数据** | 12 条定式路线 / 79 节点（`knowledge.ts:12-25`）；6 个来源（`:5-8`）；学习案例库 `userData/learning/library.json` | 代码常量 + 本地 JSON | 经局面匹配后以 `knowledge` / `experiences` 字段注入 |
| **未接线的数据** | CCPD 开局 64 局前 20 手，CC-BY-4.0（`src/data/ccpd/openings.json`，由 `scripts/import-ccpd.ts` 生成） | JSON 文件 | **`src/` 里没有任何 import**（`grep -rn ccpd src` 只命中数据文件本身） |
| **人读文档** | `RULES.md`、`EXPERT.md`、`LEARNING.md`、`KNOWLEDGE-SOURCES.md` | Markdown | 模型看不到 |

### 2.4 模型每次请求实际看到什么

```text
系统提示词（L1 装配）
  ├ SYSTEM 常量（pi-driver.ts:10-24）：身份、规则摘要、坐标、5 条工具流程、知识/案例语义、
  │   开中残局一句话、位置项说明、计划协议、输出格式 —— 约 1.5k 字，每手不变
  └ <cwd> 段（Pi 自动附加 userData 路径）
工具定义（L2）：7 个 name/description/schema；description 里再写一遍流程
用户消息（pi-driver.ts:91-100）
  ├ 轮到谁、revision、剩余棋钟、加秒说明
  ├ 完整棋谱 + 棋盘字符画
  ├ 逐手摘要 evaluations.map(ply/next/redScore/blackScore/summary)
  ├ 结构化计划 plan、最近两条机器理由
  └ JSON.stringify(port.state.analysis)：legalMoves 全部、candidates 前 8、
      expert{ material, position, safety(32 子), formation, priorities, principles,
      candidates(12 条完整 MoveReview，各含 line/variation/coverage/warnings),
      coverage, limitations, knowledge, experiences, search(含 rootScores 全部根) }
工具结果：analyze_position 再返回一遍同样的 analysis + plan（xiangqi.ts:27）
```

---

## 3. L3 的问题清单（有代码证据）

| # | 问题 | 证据 | 后果 |
|---|---|---|---|
| P1 | **流程知识硬编码在四处 TS 字符串**，没有版本号、没有索引、不能单测"内容" | `pi-driver.ts:10-24`；`xiangqi.ts:25-79`；`expert.ts:200-217,258-262`；`knowledge.ts:64-70`；`learning.ts:13-16,213` | 改一句棋理要改代码并重建；中英两套流程说明互相重复（SYSTEM 中文 vs tool description 英文），没有单一事实源 |
| P2 | **零渐进披露**：SYSTEM 全文每手常驻，与局面无关 | `pi-driver.ts:57` `systemPrompt: SYSTEM` | 开局时也在读"残局根据空间和炮架判断马炮价值"；被将军时没有专门指引 |
| P3 | **没有剧本路由**：没有 `turnGuidance()` 等价物；阶段只在 `expert.phase` 字段里出现 | `expert.ts:63-67` `phaseOf` 只用于子力值和原则触发 | five-llm 的"宿主确定性选剧本"在楚河不存在；被将军 / 大子受攻 / 读秒等情景没有不同的"怎么想" |
| P4 | **用户提示词把整份 `analysis` JSON 全量注入**，且重复 | `pi-driver.ts:99`；`analysis.candidates` 与 `analysis.expert.candidates` 两份；`plan` 在用户消息（`:97`）和 `analyze_position` 结果（`xiangqi.ts:27`）各一份；`search.rootScores` 含全部根 | 单手上下文随棋局线性增长之外，还有常数级冗余；32 枚棋子的 `safety` 全量而非只给受威胁子 |
| P5 | **工具描述承担流程说明** | `xiangqi.ts:79` `move_piece` 描述 60 余词讲审查、风险说明、坐标、revision | 描述跟着工具定义进每次请求；与 SYSTEM 第 5 条重复 |
| P6 | **没有决策证据**：`TurnNote` 只有 `reason/review/plan/riskAcknowledgement` | `src/shared/types.ts:6-7` | 无法回答"这手读了什么知识、按什么顺序调了什么工具、知识版本是什么"；复盘只能看结果（five-llm 4.5 节同类缺口） |
| P7 | **原则 `advice` 文本与触发逻辑耦合**：`knowledge()` 既算 evidence 又写文案 | `expert.ts:205-215` | 文案是业务知识，触发是代码事实；混在一起导致文案不能独立审阅、不能国际化、不能版本化 |
| P8 | **`MoveRiskError` 把整个 review JSON 塞进错误消息** | `expert.ts:272` | 纠错回路有效（`tests/pi-integration.test.ts:75`），但错误文本几 KB；模型需要的是 `risk/estimatedNet/line/warnings` 四个字段 |
| P9 | **人读文档与模型可见知识分叉** | `EXPERT.md` 第 3 节"模型被要求先看威胁…"描述的是 SYSTEM 文本，二者手工同步 | 文档漂移风险；five-llm 用 SKILL.md 同时服务人和模型，楚河没有 |
| P10 | **CCPD 64 局开局数据已导入但未使用** | `src/data/ccpd/openings.json` 存在；`knowledge.ts` 只用手写 12 条 | 有授权（CC-BY-4.0）的结构化数据闲置；`knowledgeStats()` 仍报 12/79 |
| P11 | **知识 / 经验 "怎么用" 的说明只在 SYSTEM 一句话里** | `pi-driver.ts:20` | `knowledge.applicability/caution/verification`、`experiences.match/currentMove/historicalLine` 这些字段的语义，模型只能靠一行提示理解 |

P1、P2、P3、P5、P7、P9、P11 是本次 Skill 化直接解决的；P4、P8 是并行的上下文瘦身（可拆阶段）；P6 是可观测性；P10 是数据接线。

---

## 4. five-llm 做了什么、哪些可借鉴、这次为什么不同

### 4.1 five-llm `380cb07` 实际改动（`git show 380cb07 --stat`，30 文件 +887/−188）

| 改动 | 文件 | 要点 |
|---|---|---|
| 规则 / 启发式 / 信号三分 | `rules.ts`(+55) `tactics.ts`(+87) `decision.ts`(+86)；`engine.ts` 变兼容出口(−143) | `positionSignals()` 把 `facts / priority / heuristics` 在数据结构上分开，每段带 `source` |
| 知识包 13 条 | `knowledge/SKILL.md` + `principles/*5` + `playbooks/*4` + `skills/*3` | 条目格式"触发 → 步骤 → 证据 → 局限"；frontmatter 与 Pi / Claude 技能兼容 |
| 宿主自管加载 | `knowledge-loader.ts`(+20)；`KNOWLEDGE_ITEMS` 白名单 | `noSkills: true`；`read_knowledge(id)` 参数是 13 个 ID 的 `Union` |
| 确定性路由 | `decision.ts:53-64` `turnGuidance` | 时间 > 战术事实 > 手数；只注入一份剧本全文 |
| 证据 | `DecisionTrace` 写进 `notes[].decision` | 版本、剧本、`knowledgeRead`、四步 done/skipped、验证 |
| 新工具 | `evaluate_threats / validate_move / read_knowledge` | `place_stone` 加证据门禁与提交前验证 |
| 构建 | `build.ts` 多一行 `cp knowledge → dist/business/knowledge` | 运行时按 `import.meta.url` 定位，不依赖 cwd |

### 4.2 可以直接借鉴的

| five-llm 做法 | 楚河对应 | 备注 |
|---|---|---|
| 四级可信度分开安放（代码 / 事实 / 启发式 / 文本） | 楚河的代码层已经做到；缺的是把"文本"从 TS 里拿出来 | 见 2.3 表 |
| 宿主确定性选剧本，模型只按需读 | 新增 `turnGuidance()`，输入 `phaseOf`、`inCheck`、受攻大子、棋钟余量 | 象棋比五子棋多一个"被将军"情景 |
| 入口 + 原则索引 + 一份剧本常驻，其余按需 | 相同 | 预算见 6.6 |
| 知识读取参数是 enum 不是路径 | `read_skill(name)` 的 `name` 来自 `getSkills()` 名字集合 | 不开放文件系统 |
| 版本化 `DecisionTrace` 随棋谱原子保存 | `TurnNote.decision` | 楚河记录格式 `chinese-chess/v1` 只增可选字段 |
| 构建时复制知识目录到 `dist/` | `build.ts` 加一行 `cp skills → dist/skills` | 打包进 asar |
| 完整性测试：条目数、frontmatter、白名单一致 | `tests/skills.test.ts` | 用 Pi 的 `loadSkillsFromDir` 做校验，不自己解析 |

### 4.3 这次不同：自建知识包 vs Pi Skill

| 维度 | five-llm 自建（`knowledge-loader.ts`） | 楚河用 Pi Skill（本文方案） | 取舍 |
|---|---|---|---|
| 发现 | 代码常量 `KNOWLEDGE_ITEMS` 列出文件 | `DefaultResourceLoader({ noSkills: true, additionalSkillPaths: [dir] })` 递归找 `SKILL.md`（`pi/dist/core/resource-loader.js:424-426`） | 新增条目不改白名单代码；名字集合在测试里断言 |
| 校验 | 无（空文件抛错） | Pi 校验 name 字符集 / 长度、description 必填、名字冲突产生 `diagnostics`（`pi/docs/skills.md:81-85`） | 免费获得 |
| 索引格式 | 自拼 `- id: description` | `formatSkillsForPrompt(skills, 'indirect')` 输出 `<available_skills>` XML（`pi/dist/core/skills.js:278-303`，导出见 `pi/dist/index.d.ts:23`） | 与 Agent Skills 标准一致，模型见过这种格式 |
| 全文读取 | `readFileSync(KNOWLEDGE_ITEMS[id].file)` | 读 `skill.filePath`；`references/` 用 `skill.baseDir` 解析并校验前缀 | 都是宿主读，不开 `read` 工具 |
| 命令展开 | 无 | `/skill:name args` 由 `AgentSession._expandSkillCommand` 展开为 `<skill name= location=>…</skill>`（`pi/dist/core/agent-session.js:1727-1740`） | 可选：宿主用它注入入口技能 |
| 互操作 | 格式兼容但不被 Pi 识别 | 同一目录可被 Pi TUI 直接加载（赛后复盘场景，6.2 节 K8） | 这是最大的增量价值 |
| 分发 | 随应用 build | 可选 Pi Package（第 7 节） | 现阶段不发 |
| 隔离 | 不扫描任何目录 | `noSkills: true` 时**只**加载 `additionalSkillPaths`，不扫 `.pi/skills`、`~/.pi/agent/skills`（`resource-loader.js:424-426`） | 隔离等价 |

**结论**：five-llm 自建的那 20 行加载器和白名单，在 Pi 1.4.0 里都有现成且更严格的对应物，而且 `noSkills + additionalSkillPaths` 这一组选项正好提供了"只加载我的、不加载用户的"。自建的唯一剩余理由（不开放文件读取工具）通过"宿主读文件 + enum 参数"解决，与 five-llm 相同。

### 4.4 five-llm 的三个否决 / 暂缓在楚河是否仍成立

| five-llm 的结论 | 楚河 |
|---|---|
| 否决 `.five-llm/state` 第二状态源 | **仍否决**。楚河已有 `GameService` 单写者 + `learning/library.json` 原子事务两个状态源，不能再加第三个 |
| 暂缓 review-agent / simulate-agent | **仍暂缓**。楚河已有确定性 `reviewMove` + 最终搜索做独立审查（`game-service.ts:257-265`） |
| 验证放在提交**之前** | 楚河已经是：`commit()` 内 `reviewMove` + 最终搜索，风险先返回不落子（`game-service.ts:275-277`） |

---

## 5. Pi Skill / Package 的真实机制（1.4.0，含出处）

> 所有说法均核对过本地 `pi/docs` 与 `pi/dist`。标注"待验证"的是没有实际跑过的推断。

### 5.1 SKILL.md 格式与发现路径（`pi/docs/skills.md`）

- 技能 = 含 `SKILL.md` 的目录，可带 `scripts/ references/ assets/`（`:11-22`）。实现 [Agent Skills 规范](https://agentskills.io/specification)（`:7`）。
- frontmatter 字段：`name`（必填，小写字母数字连字符，≤64）、`description`（必填，≤1024，决定何时加载）、`license`、`compatibility`、`metadata`、`allowed-tools`（**实验性**）、`disable-model-invocation`（`:67-85`）。
- Pi **不要求** `name` 与目录名一致，但其他实现可能要求，建议一致（`:83`）。
- 畸形文件或缺 description 的技能**不加载**；名字冲突保留先发现者并产生 warning（`:85`）。
- 发现路径：用户 / 项目 skills 目录递归；另支持 `~/.agents/skills/` 与 `.agents/skills/`（`:59-61`）；设置项 `skills: string[]` 可加路径（`pi/docs/settings.md:156`）。
- `/skill:name args` 强制加载；`disable-model-invocation: true` 时只能这样调用；`enableSkillCommands` 控制命令菜单是否出现（`:45-53`；`settings.md:159`）。
- 改完技能在交互会话里 `/reload`（`:89`）。

### 5.2 技能怎样进系统提示词（关键：需要 `read` 或 `bash`）

- `formatSkillsForPrompt(skills, fileReadTool)`（`pi/dist/core/skills.js:278-303`）：过滤掉 `disableModelInvocation` 的技能，输出引导句 + `<available_skills><skill><name/><description/><location/></skill>…</available_skills>`。`fileReadTool` 为 `"read" | "bash" | "indirect"`，决定引导句是"Use the read tool…"、"Use bash…"还是中性的"Load a skill's file…"（`skills.d.ts:48`）。
- `buildSystemPromptSections`（`pi/dist/core/system-prompt.js:101-109`）：
  ```js
  const readers = ["read", "bash"];
  const skillFileReadTool = readers.find(t => declaredTools.includes(t))
      ?? (readers.some(t => selectedTools.includes(t)) ? "indirect" : undefined);
  if (skillFileReadTool && skills.length > 0) promptSections.skills = formatSkillsForPrompt(skills, skillFileReadTool)
  ```
  **结论：楚河 `noTools: 'builtin'` 且 7 个自定义工具里没有 `read`/`bash`，所以即使把技能加载进 ResourceLoader，Pi 也不会自动输出 `<available_skills>` 段。** 宿主必须自己调用导出的 `formatSkillsForPrompt(skills, 'indirect')` 把索引拼进 `systemPrompt`。
- `customPrompt`（即 `DefaultResourceLoader` 的 `systemPrompt`）只替换 `preamble` 段（`system-prompt.js:78-80`），skills 段的生成逻辑独立于它（`:101-109`）；five-llm 白皮书 6.2 节"customPrompt 后不再生成 tools / rules / docs 段"与此一致。

### 5.3 SDK 下的控制点

| 能力 | 出处 |
|---|---|
| `DefaultResourceLoaderOptions`：`additionalSkillPaths?: string[]`、`noSkills?: boolean`、`skillsOverride?: (base) => { skills, diagnostics }`、`systemPrompt`、`appendSystemPrompt` | `pi/dist/core/resource-loader.d.ts:70-100` |
| `noSkills: true` 时 `skillPaths = mergePaths(cliEnabledSkills, additionalSkillPaths)`，不含项目 / 用户设置里的技能；`noSkills && skillPaths.length === 0` 才返回空 | `pi/dist/core/resource-loader.js:424-426`、`:626-640` |
| `loadSkills({ includeDefaults: false })` 之后应用 `skillsOverride` | `resource-loader.js:632-640` |
| `loader.getSkills(): { skills: Skill[]; diagnostics }` | `resource-loader.d.ts:34-36`；`pi/examples/sdk/04-skills.ts:42` |
| `Skill` 类型：`name, description, filePath, baseDir, sourceInfo, disableModelInvocation` | `pi/dist/core/skills.d.ts:9-16` |
| 包根导出 `formatSkillsForPrompt, loadSkills, loadSkillsFromDir, type Skill, createSyntheticSourceInfo` | `pi/dist/index.d.ts:23-24` |
| 合成技能（不落盘）示例 | `pi/examples/sdk/04-skills.ts:18-26` |

### 5.4 `/skill:name` 展开

- `session.prompt(text)` 默认 `expandPromptTemplates = true`（`pi/dist/core/agent-session.js:1636`），会先走 `input` 事件，再 `_expandSkillCommand`（`:1659-1662`）。
- `_expandSkillCommand`（`:1727-1740`）：匹配 `/skill:<name>`，从 `resourceLoader.getSkills()` 找技能，读文件、去 frontmatter，包成 `<skill name="…" location="…">\nReferences are relative to <baseDir>.\n\n<body>\n</skill>`，后接 args。未知技能原文透传。
- 同一机制在 `steer/followUp` 队列路径也生效（`:1755-1760`）。
- `enableSkillCommands` 只影响命令**注册 / 菜单**（`:2755-2760`、`pi/dist/core/settings-manager.js:914`），不影响上述展开。**待验证**：没有实际在 `SessionManager.inMemory()` + 自定义 `systemPrompt` 组合下跑过 `/skill:` 前缀。

### 5.5 扩展侧钩子：`resources_discover`

- 事件 `{ type: "resources_discover", cwd, reason: "startup" | "reload" }`，返回 `{ skillPaths?, promptPaths?, themePaths? }`（`pi/dist/core/extensions/types.d.ts:552-562`）；在 `session_start` 之后触发（`pi/docs/extensions.md:142`）。
- 对楚河意义有限：技能路径由宿主在创建 loader 时就知道，用 `additionalSkillPaths` 更直接。这个钩子适合"扩展自己带技能"的 TUI 场景（第 7 节）。

### 5.6 Pi Package（`pi/docs/packages.md`）

- 包 = 普通目录或 npm 包；约定目录 `extensions/ skills/ prompts/ themes/` 自动发现（`:44-55`），或在 `package.json` 的 `pi` 键声明路径（`:57-72`）。
- 安装：`pi install npm:…|git:…|./local`；`--local` 写入项目 `.pi/settings.json`，**项目包需信任后才加载**（`:9-21`）；`pi -e <pkg>` 临时试用（`:23-27`）。
- 本地路径不复制，按路径加载（`:36,40`）。
- **宿主提供的包（`pi-ai / pi-agent-core / pi-coding-agent / pi-tui / typebox`）要放 `peerDependencies: "*"`，不能放 `dependencies`，否则 Pi 报扩展 warning**（`:80-90`）。注意：楚河 `package.json` 把 `@earendil-works/pi-coding-agent` 放在 `dependencies`（正确，因为它是 SDK 宿主），所以**应用的 `package.json` 不能同时兼做 Pi package manifest**。
- 设置里可按类型过滤包资源（`:94-119`）。

### 5.7 仓库里已有的技能用法（可参考的样板）

| 位置 | 用法 |
|---|---|
| `.pi/skills/bowser/SKILL.md` | 本仓库唯一的真 Pi 技能：`allowed-tools: Bash`，`## Purpose / Key Details / Workflow / Quick Reference` 结构，引用 `docs/playwright-cli.md` 相对路径 |
| `.pi/agents/pi-pi/skill-expert.md` | 子 Agent 定义，列出了 SKILL.md 字段与发现路径清单（与 5.1 一致） |
| `extensions/cross-agent.ts:97-200` | 扩展自己扫描外部 `skills/` 目录并用 `pi.registerCommand('skill:'+name)` + `pi.sendUserMessage(content + Task)` 模拟技能命令 —— 这是"自建加载"的反例，本文不采用 |
| `.pi/settings.json` | `prompts: ["../.claude/commands"]` 跨工具复用提示词；说明 `.pi/settings.json` 是项目级资源入口 |
| `apps/five-llm/src/business/knowledge/**` | 13 个与 Pi 兼容的 SKILL.md 写法样板 |

### 5.8 待验证清单（Pi 机制）

| # | 事项 | 为什么还不确定 |
|---|---|---|
| V1 | `noSkills: true` + `additionalSkillPaths` 在 Electron asar 内路径下能否正常 `readdir` | Pi 用 `fs` 直接读；asar 对 `fs` 有兼容层，但 `canonicalizePath`/`realpath`（`skills.js:328`）在 asar 里的行为未测 |
| V2 | `/skill:name` 前缀在 `inMemory` Session + `systemPrompt` 替换下的实际展开效果 | 只读了源码，未运行 |
| V3 | `allowed-tools` frontmatter 是否被 1.4.0 执行 | `docs/skills.md:78` 标"实验性"；`agent-session.js:145,193` 的 `_allowedTools` 来自 `allowedToolNames` 配置，没看到从技能 frontmatter 读取的代码 |
| V4 | `formatSkillsForPrompt` 的 `<location>` 绝对路径会暴露 `userData` / 安装路径 | 已确认会输出 `filePath`；是否改为相对路径需要自拼或接受 |
| V5 | 本地目录作为 Pi package（`pi -e ./apps/chinese-chess/skills`）被 TUI 直接加载 | 文档 `packages.md:40` 说"目录按常规包发现规则"，但一个只有 `SKILL.md` 子目录、无 `package.json` 的目录是否算包，未测；更稳妥的是走 `settings.skills` 路径或 `.agents/skills` |

---

## 6. 目标设计

### 6.1 设计原则

1. **四级可信度不变**：规则在代码、事实在信号、启发式带 `limitations`、经验在 Markdown。Skill 只承载第四级，不能改写前三级。
2. **分工**：Pi 负责技能的**发现、校验、索引格式、命令展开**；宿主负责**选哪份注入、允许读哪些、何时读、记录读了什么**。
3. **不开放文件系统**：模型通过 `read_skill(name, reference?)` 读，参数是 enum；宿主用 `path.resolve` + `startsWith(baseDir)` 校验 reference 路径。
4. **每手重建**：沿用一手一 Session；系统提示词 = 稳定前缀（身份 + 坐标 + 技能索引）+ 可变尾部（当前剧本全文），利于 provider 前缀缓存（five-llm 白皮书 7.2 #3）。
5. **版本化**：`SKILLS_VERSION = 'xiangqi-skills/v1'` 写进 `DecisionTrace`；语义变化升级。
6. **人机同源**：`RULES.md` / `EXPERT.md` 继续给人看；模型看的是 skill；重叠部分（坐标、规则摘要）由 skill 的 `references/` 承载，`EXPERT.md` 改为链接到 skill 目录而不是复述流程。

### 6.2 L3 拆分总表

| 块 | 内容 | 载体 | 常驻 / 按需 | 从哪里迁来 |
|---|---|---|---|---|
| **K0 硬规则** | 走法、将帅安全、终局、棋钟、revision、一次提交、风险复查阈值 250 | **代码**（不动）：`engine.ts`、`clock.ts`、`game-service.ts` | 错误即提示词 | — |
| **K1 入口技能 `xiangqi-coach`** | 每回合固定四步：observe（读报告）→ compare（候选与反击 / 搜索）→ plan（复核计划）→ commit（提交，必要时风险说明）；路由与冲突规则；预算 | `skills/xiangqi-coach/SKILL.md` | **常驻全文** | `pi-driver.ts:14-19,23-24` |
| **K2 原则 `principle-*`** | 5–6 条一句话原则：`principle-rules`（代码裁决）、`principle-facts-over-heuristics`、`principle-threats-first`（先应将 / 杀 / 大子）、`principle-exchange-before-greed`（吃兵前算丢马炮）、`principle-clock`、`principle-single-commit` | `skills/principles/principle-*/SKILL.md` | **索引常驻**（Pi 的 `<available_skills>`），全文按需 | `pi-driver.ts:11-12,17`；`expert.ts:264` limitations |
| **K3 剧本 `playbook-*`** | `opening`、`middlegame`、`endgame`、`in-check`（被将军：先列合法应将，比较垫 / 吃 / 避）、`under-attack`（大子受攻：撤 / 保 / 反击 / 兑）、`time-pressure`、`risk-acknowledgement`（何时允许弃子说明） | `skills/playbooks/playbook-*/SKILL.md`，`disable-model-invocation: true`（由宿主选，不让模型自选） | **宿主每手选 1 份全文注入**；其他按需读 | `pi-driver.ts:16-19,21`；`expert.ts:207,213,215` 的 advice |
| **K4 专项技能 `skill-*`** | `read-expert-report`（`safety/formation/priorities/coverage/limitations` 各字段含义，几何保护≠合法回吃）；`compare-candidates`（`review_move` / `compare_moves` / `search_position` 的用法、`rootScope`、`completedDepth` 解读）；`plan-protocol`（`update_plan` 的 continue / revise / abandon 与失效条件）；`use-knowledge-hints`（`knowledge.*` 与 `experiences.*` 字段：只用 `currentMove/currentLine`，不照搬 `historicalLine`）；`coordinates`（A–I / 0–9、大小写、翻转不变） | `skills/skills/<name>/SKILL.md` + `references/*.md` | 索引常驻，全文按需 | `pi-driver.ts:15-20,22`；`xiangqi.ts` 七个 description；`EXPERT.md` §1–3 |
| **K5 原则触发（代码）+ 文案（skill）** | `expert.ts:200-217` 继续按局面计算 `{ id, evidence }`；`advice` 缩成一句，全文放 `skills/skills/read-expert-report/references/principles.md`，按 `id` 对应 | 代码 + reference | 一句话随报告；全文按需 | `expert.ts:205-215,259-262`；`knowledge.ts:66-70` |
| **K6 开局知识（数据）** | 12 条手写路线 + **接线 CCPD 64 局**（P10）；局面匹配、对称、候选复核仍在 `knowledge.ts` | `src/data/*.json` + 代码 | 匹配后以 `knowledge` 字段注入（不变） | `knowledge.ts:12-25`；`src/data/ccpd/openings.json` |
| **K7 学习经验（数据 + 文案）** | 案例验证 / 召回仍在 `learning.ts`；`MOTIF_TEXT`（`:13-16`）与召回建议（`:213`）迁到 `use-knowledge-hints/references/motifs.md` | 代码 + reference | `experiences` 字段不变；文案按需 | `learning.ts:13-16,213` |
| **K8 离线复盘技能 `xiangqi-review`（可选）** | 在 **Pi TUI** 里对 `userData/records/*.json` 做人工复盘：读棋谱、调用 `bun scripts/learn.ts`、解释 `PostGameReview.findings` | `skills/xiangqi-review/SKILL.md`，`allowed-tools: Bash read`（V3 待验证） | 不进应用；TUI 中 `/skill:xiangqi-review <file>` | `LEARNING.md` §二–三；这是 Pi 技能机制**原生**可用（有 `read`/`bash`）的场景 |

### 6.3 目录布局草图

```text
apps/chinese-chess/
├── skills/                                  # Pi package 约定目录名，便于以后打包或 TUI 直接加载
│   ├── xiangqi-coach/
│   │   ├── SKILL.md                         # K1 入口，常驻
│   │   └── references/
│   │       ├── rules-summary.md             # 从 RULES.md 精简的模型版规则摘要（坐标、终局、重复）
│   │       └── workflow.md                  # 四步细则与跳过条件
│   ├── principles/
│   │   ├── principle-rules/SKILL.md
│   │   ├── principle-facts-over-heuristics/SKILL.md
│   │   ├── principle-threats-first/SKILL.md
│   │   ├── principle-exchange-before-greed/SKILL.md
│   │   ├── principle-clock/SKILL.md
│   │   └── principle-single-commit/SKILL.md
│   ├── playbooks/                           # 全部 disable-model-invocation: true
│   │   ├── playbook-opening/SKILL.md
│   │   ├── playbook-middlegame/SKILL.md
│   │   ├── playbook-endgame/SKILL.md
│   │   ├── playbook-in-check/SKILL.md
│   │   ├── playbook-under-attack/SKILL.md
│   │   ├── playbook-time-pressure/SKILL.md
│   │   └── playbook-risk-acknowledgement/SKILL.md
│   ├── skills/
│   │   ├── read-expert-report/{SKILL.md, references/principles.md, references/fields.md}
│   │   ├── compare-candidates/{SKILL.md, references/search-report.md}
│   │   ├── plan-protocol/SKILL.md
│   │   ├── use-knowledge-hints/{SKILL.md, references/motifs.md}
│   │   └── coordinates/SKILL.md
│   └── xiangqi-review/{SKILL.md, scripts/learn.sh}     # K8 可选，只给 TUI 用
├── src/agent/skill-loader.ts                # 用 Pi 的 loader 读 skills/，拼索引，读全文；无自定义解析
├── src/business/decision.ts                 # turnGuidance()、DecisionTrace、SKILLS_VERSION（纯函数）
└── scripts/build.ts                         # + cp('skills', 'dist/skills')
```

Pi 的发现规则（`skills.d.ts:29-34`）："目录含 `SKILL.md` 即技能根、不再下钻；否则递归子目录"。所以 `skills/principles/` 这类中间目录可以没有 `SKILL.md`。`xiangqi-review` 不该被应用注入：用 `skillsOverride` 过滤掉（或放到 `skills/` 之外，见 D4）。

### 6.4 两个 SKILL.md 示例

**入口（常驻）**

```markdown
---
name: xiangqi-coach
description: 楚河中国象棋每回合决策入口。先读业务专家报告与威胁，再比较候选的对方最强反击和多步搜索，复核跨回合计划，最后用 move_piece 提交一手合法走子。
metadata:
  version: xiangqi-skills/v1
  layer: L3
---

# 象棋决策编排

你是棋手，不是编程助手。规则、棋钟、revision 由业务代码裁决，本技能不能改写。
每回合四步，步骤 ID 固定为 observe / compare / plan / commit；进度由工具实际调用记录。

1. **observe**：先读用户消息里的 `signals`（被将军、受攻大子、对方上一手、阶段）。
   需要全量报告时调用 analyze_position；字段含义见 read_skill("read-expert-report")。
2. **compare**：提出 2–3 个不同意图的候选（直接防守 / 主动解围 / 改善或反击），
   用 compare_moves 或 review_move 查一手反击与同格交换，用 search_position 看多步。
   未算完 = 未知，不是安全。用法见 read_skill("compare-candidates")。
3. **plan**：调用 update_plan。没有计划或已失效 → revise；仍成立 → continue 并说明对方这手是否改变威胁。
4. **commit**：move_piece 携带当前 revision 和简短中文公开理由。业务层会独立复查；
   收到风险反驳时优先改选，只有具体补偿或不可避免败势才填 riskAcknowledgement
   （见 playbook-risk-acknowledgement）。成功后回合结束，不要再调用工具。

## 路由
宿主已按局面选定一份剧本附在本提示词末尾；其余剧本和技能按需用 read_skill 读取，
每次读取消耗工具预算（单回合 8 次模型请求 / 16 次工具调用），不要逐项全读。
```

**剧本（宿主选择，模型不可自选）**

```markdown
---
name: playbook-in-check
description: 当前被将军时的应手流程：穷举合法应将，按吃掉将军子、垫子、移将的顺序比较，先排除一步被杀的应法。
disable-model-invocation: true
metadata:
  version: xiangqi-skills/v1
  trigger: signals.inCheck === true
---

# 被将军

1. `analysis.legalMoves` 已经只剩合法应将；不要考虑其他走法。
2. 优先级：能合法吃掉将军子且不被回吃 → 垫子（注意被垫的子是否随即失守）→ 移将（注意照面与困毙）。
3. 对每个候选用 review_move 看 `losingReply` 与 `estimatedNet`；有 `losingReply` 的直接排除。
4. 若所有应将都亏子，选 `estimatedNet` 最高且 `coverage.complete` 的一手；在 reason 里承认局面困难，不虚构补偿。
5. 被将军时旧计划一律 revise，不能 continue（业务层也会拒绝）。

局限：同格交换不覆盖异地弃子与连续将军组合；`search_position` 的 `completedDepth` 才是多步证据。
```

### 6.5 运行时注入机制

**加载（L1 `PiDriver`，改动集中在 `pi-driver.ts:53-59` 一处）**

```ts
const resourceLoader = new DefaultResourceLoader({
  cwd, agentDir: getAgentDir(), settingsManager,
  noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  noSkills: true,                                   // 不扫用户/项目技能（resource-loader.js:424-426）
  additionalSkillPaths: [skillsDir],                // 只加载应用自带目录
  skillsOverride: base => ({ skills: base.skills.filter(s => s.name !== 'xiangqi-review'), diagnostics: base.diagnostics }),
  extensionFactories: [xiangqiExtension(port, guidance)],
  systemPrompt: assembleSystemPrompt(skills, guidance),   // 见下
  appendSystemPromptOverride: () => [],
});
await resourceLoader.reload();
const { skills, diagnostics } = resourceLoader.getSkills();
if (diagnostics.length || !sameSet(skills.map(s => s.name), EXPECTED_SKILLS)) throw new Error('技能隔离校验失败');
```

注意 `skillsDir` 必须在 `reload()` 之前就能确定（`import.meta.url` 相对 `dist/`），而 `systemPrompt` 需要 `skills` 列表 —— 所以实际顺序是：先用 `loadSkillsFromDir({ dir: skillsDir, source: 'app' })`（`pi/dist/index.d.ts:23` 导出）拿到列表拼提示词，再创建 loader；或者创建 loader 后用 `session.prompt()` 前的 `before_agent_start` 改 `systemPromptOptions`。前者更简单，且与"工具隔离校验"同一位置。**待验证**：`loadSkillsFromDir` 与 loader 内部 `loadSkills` 对同一目录是否产出相同 `filePath`（canonicalize 后应一致）。

**系统提示词装配（稳定前缀 → 可变尾部）**

```text
[1] SYSTEM 精简版：身份 + 坐标约定 + "规则由代码裁决" + 预算            ← 常量，约 300 字
[2] xiangqi-coach 全文（readFileSync(coach.filePath) 去 frontmatter）     ← 常量
[3] formatSkillsForPrompt(visibleSkills, 'indirect')                      ← 常量；'indirect' 文案不提 read 工具
    （剧本因 disable-model-invocation 不出现在索引里，符合"模型不自选剧本"）
[4] "## 当前剧本：playbook-in-check" + 全文                                 ← 每手可变
```

另一种方案是把 [2]+[4] 放到用户消息里，用 `/skill:xiangqi-coach <回合内容>` 让 Pi 的 `_expandSkillCommand` 展开（5.4）。优点是复用 Pi 的 `<skill>` 包装；缺点是入口文本进入每手都不同的用户消息、不利缓存，且 V2 未验证。**建议 A（系统提示词）为主，B 作为 TUI 复盘场景（K8）的用法。**

**新工具 `read_skill`（L2）**

```ts
pi.registerTool(defineTool({
  name: 'read_skill', label: '读取技能全文', executionMode: 'sequential',
  description: 'Read one bundled skill or one of its reference files by name. Names are an enum; no file paths.',
  parameters: Type.Object({
    name: Type.Union(readable.map(s => Type.Literal(s.name))),        // 来自 getSkills()，含剧本（允许模型读别的剧本）
    reference: Type.Optional(Type.String({ pattern: '^[a-z0-9-]+\\.md$' })),
  }),
  async execute(_id, { name, reference }) {
    active();
    const skill = byName.get(name)!;
    const file = reference ? path.resolve(skill.baseDir, 'references', reference) : skill.filePath;
    if (!file.startsWith(skill.baseDir + path.sep)) throw new Error('越界的技能引用');
    trace.skillsRead.push(reference ? `${name}/${reference}` : name);
    return result({ version: SKILLS_VERSION, name, reference, text: stripFrontmatter(readFileSync(file, 'utf8')) });
  },
}));
```

不把这个工具命名为 `read`：否则 `system-prompt.js:102-104` 会把引导句改成"Use the read tool to load a skill's file"，而我们的 `read` 不接受路径，文案会误导。

**工具描述瘦身（L2）**：七个工具的 `description` 只保留"做什么、参数、返回哪些字段、不提交"；流程性语句（"先调用 analyze_position"、"不要例行加 riskAcknowledgement"）移入 K1 / K3。参照 `tests/pi-integration.test.ts:67` 的断言，工具名集合不变（加一个 `read_skill`，`XIANGQI_TOOLS` 变 8 个）。

**路由（L3 `decision.ts`，纯函数）**

```text
终局 → 不启动
inCheck → playbook-in-check
剩余棋钟 < max(60s, 3 × 平均用时) 或 包干余时 < 90s → playbook-time-pressure
存在 value ≥ 400 且 legalAttackers 非空的己方子 → playbook-under-attack
phaseOf === 'opening' → playbook-opening
phaseOf === 'endgame' → playbook-endgame
否则 → playbook-middlegame
```

`playbook-risk-acknowledgement` 不参与路由，只在 `MoveRiskError` 的错误文本里提示"见 read_skill('playbook-risk-acknowledgement')"（同时把 P8 的错误消息缩成四个字段 + 提示）。阈值数字是草案，需要用 `tests/fixtures/*` 的实战局面校准。

**证据（L3 → `TurnNote.decision`）**

```ts
interface DecisionTrace {
  version: 'xiangqi-skills/v1'; revision: number; playbook: string;
  skillsInjected: string[];        // coach + 选中剧本
  skillsRead: string[];            // read_skill 实际读过的（含 reference）
  tools: { name: string; ok: boolean }[];   // 按调用顺序，由 tool_execution_end 记录
  steps: { id: 'observe' | 'compare' | 'plan' | 'commit'; status: 'done' | 'skipped'; evidence: string }[];
}
```

吸取 five-llm 4.5 节的四条教训：`skillsInjected` 与 `skillsRead` 分开；`tools` 记完整序列而不是覆盖式标志；失败回合也在 `GameState.logs` 外另记一条 `attempts[]`（可留到阶段 4）。

### 6.6 常驻 vs 按需的预算估算

| 段 | 现状（字符，估算） | 目标 |
|---|---|---|
| SYSTEM 常量 | ~1,500 | ~300（身份、坐标、硬约束） |
| 入口 coach 全文 | 0 | ~900 |
| 技能索引（6 原则 + 5 技能，name + description + location） | 0 | ~1,200（location 绝对路径占一半，见 V4） |
| 当前剧本全文 | 0 | ~500 |
| 七个工具 description | ~1,800 | ~800 |
| **系统提示词 + 工具合计** | **~3,300** | **~3,700**（略增，但结构化、可缓存、可路由） |
| 用户消息里的 `analysis` JSON | 数 KB–数十 KB（随候选 / 搜索增长） | 见 6.7，目标减半 |

Skill 化本身不省 token，省的是 P4 的瘦身；它换来的是 G1–G5。这一点要在拍板时说清楚。

### 6.7 与 Skill 化并行的上下文瘦身（P4、P8，可独立成阶段）

1. 用户消息只放 `signals`：`inCheck`、`lastMove`、`priorities`、受攻子（`safety.filter(legalAttackers.length)`）、`material`、`phase`、`candidates` 前 6 条的 `{ notation, risk, estimatedNet, line }`、`search.bestMove/completedDepth/rootScope`、`knowledge`、`experiences`、`plan`、`limitations`。
2. 全量 `analysis` 只经 `analyze_position` 返回；`analysis.candidates`（前 8 标签）与 `expert.candidates` 二选一。
3. `MoveRiskError.message` 只含 `risk / estimatedNet / line / warnings` + "read_skill('playbook-risk-acknowledgement')"，完整 review 放 `details`（Pi 的 tool result `details` 不进上下文；five-llm 用法同）。
4. `evaluations` 摘要最多保留最近 20 手 + 吃子手。

---

## 7. 要不要用 Pi Package 打包

### 7.1 两种可能的用途

| 用途 | 谁用 | 需要什么 |
|---|---|---|
| A. 应用运行时加载技能 | 楚河 Electron 应用 | **不需要 package**：`additionalSkillPaths` 指向 `dist/skills` 即可；`pi install` 写的是 `~/.pi/agent/settings.json`，而应用用 `SettingsManager.inMemory()`（`pi-driver.ts:49`）根本不读它 |
| B. 在 Pi TUI 里复用同一套技能做赛后复盘 / 调试提示词 | Sean 在 `apps/chinese-chess` 下开 `pi` | 让 TUI 发现 `skills/`：最简单是项目 `.pi/settings.json` 加 `"skills": ["../skills"]`（`settings.md:150-156`，路径相对项目 `.pi/`），或放到 `.agents/skills/`（`skills.md:61`）；**也不需要 package** |
| C. 把技能 + 一个 TUI 用的 `xiangqi-review` 扩展分发给别人 / 另一台机 | 未来 | 这才需要 package：独立子目录，`peerDependencies` 声明宿主包（`packages.md:88-90`） |

### 7.2 manifest 草图（仅当走 C 时）

```text
packages/pi-xiangqi/                 # 不能复用 apps/chinese-chess/package.json（见 5.6 末条）
├── package.json
├── skills/  →  ../../apps/chinese-chess/skills（符号链接或构建时复制；packages.md:72 提醒符号链接根要显式列出）
└── extensions/
    └── xiangqi-review.ts            # TUI 扩展：注册 /xq-review，读 records/*.json，调 business/learning.ts
```

```json
{
  "name": "@aicoder2048/pi-xiangqi",
  "version": "0.1.0",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/*.ts"],
    "skills": ["./skills", "!./skills/playbooks/**"],
    "prompts": [],
    "themes": []
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "typebox": "*"
  }
}
```

`!./skills/playbooks/**` 的意思是：剧本是宿主路由专用的，在 TUI 里没有路由器，发出去只会让模型自选剧本。

### 7.3 结论

**现阶段不发 package，但目录按 package 约定命名（`skills/`），并在项目 `.pi/settings.json` 里加一行让 TUI 能用。** 理由：

1. 用途 A、B 都不需要 package（YAGNI）。
2. 应用的 `package.json` 把 Pi 放在 `dependencies`，与 package 规范冲突，需要另开目录，这是额外维护面。
3. 应用内嵌 SDK 版本锁 1.4.0，package 走用户机器上的 Pi 版本，两者技能格式虽然兼容，但 `read_skill` 的 enum 与 `DecisionTrace` 只在应用里有意义；分发出去的技能在没有业务工具的环境里只是一堆"怎么用 analyze_position"的说明。
4. 等 K8 `xiangqi-review` 扩展真的写出来、且有第二个使用者时，再做 C。

---

## 8. 迁移步骤

### 阶段 1：技能目录 + Pi 加载 + 索引注入（不改任何工具语义）

- **目标**：`skills/` 建好 K1、K2、K4（原则与技能的文本先从 `pi-driver.ts:10-24` 原样搬，不改措辞）；`PiDriver` 用 `noSkills + additionalSkillPaths` 加载；系统提示词 = 精简 SYSTEM + coach 全文 + `formatSkillsForPrompt(…, 'indirect')`。`build.ts` 复制 `skills/` 到 `dist/skills/`。
- **验收**：
  - `getSkills().diagnostics` 为空；名字集合等于 `EXPECTED_SKILLS`；缺目录时本回合显式失败、棋钟继续（与 five-llm 一致）。
  - `tests/pi-integration.test.ts` 第一条：`requests[0].messages[0].content` 含 `<available_skills>` 与 `xiangqi-coach`；工具集合仍是 7 个。
  - 现有全部测试通过；`just smoke` 通过；打包后的 `楚河.app` 能从 asar 读到技能（V1）。
- **测试**：新增 `tests/skills.test.ts`：用 `loadSkillsFromDir` 校验每个 SKILL.md 的 `name` 等于目录名、`description` ≤ 1024 且含"何时用"；索引字符数上限断言。

### 阶段 2：路由 + 剧本 + `read_skill` + `DecisionTrace`

- **目标**：`decision.ts` 的 `turnGuidance()`；K3 七份剧本；`read_skill` 工具；`TurnNote.decision`；`XIANGQI_TOOLS` 变 8 个。
- **验收**：
  - `turnGuidance` 单测覆盖：被将军优先于时间；受攻大子优先于阶段；终局不启动；用 `tests/fixtures/human-mistakes.ts`、`passive-game.ts` 的局面回放验证路由分布合理。
  - 集成测试：模型调用 `read_skill('playbook-endgame')` 返回全文且 `trace.skillsRead` 记录；越界 `reference` 被拒。
  - 成功落子的 `notes[].decision` 含 `skillsInjected ≠ skillsRead`、`tools` 顺序与 fixture 请求顺序一致。
  - 导出 JSON 格式仍为 `chinese-chess/v1`，旧棋谱无 `decision` 字段也能被 `learning.ts:73` 的 `normalizeRecord` 接受。
- **测试**：`tests/decision.test.ts`、扩展 `pi-integration.test.ts`、`service.test.ts` 加 decision 持久化断言。

### 阶段 3：文案迁移与瘦身

- **目标**：`expert.ts:200-217` 的 `advice` 缩成一句，全文迁 `references/principles.md`；`knowledge.ts:66-70`、`learning.ts:13-16,213` 文案迁 reference；七个工具 description 瘦身；`MoveRiskError` 消息缩短（6.7 第 3 条）；用户消息改为 `signals`（6.7 第 1–2、4 条）。
- **验收**：
  - `tests/expert.test.ts`、`knowledge.test.ts`、`learning.test.ts` 全部通过（它们断言的是 `id/evidence/risk/estimatedNet`，不是文案；但 `knowledge.test.ts:37` 断言 `caution` 含"不能直接裁定胜和"，需要确认该字段是保留还是迁走——见 D5）。
  - 固定局面（初始、`human-mistakes` 第 42 手、`passive-game` 第 53 手）上，第一次请求的总字符数相对阶段 1 下降 ≥ 40%。
  - `pi-integration.test.ts:75`"收到送车反例后改选"仍通过。
- **测试**：新增 prompt 尺寸回归测试（给定局面 → 系统提示词 + 用户消息字符上限）。

### 阶段 4（可选）：数据接线、TUI 复盘、可观测性

- **目标**：K6 接线 CCPD（`knowledge.ts` 读 `src/data/*.json`，`knowledgeStats()` 更新，`KNOWLEDGE_SOURCES` 加 CCPD 条目，`KNOWLEDGE-SOURCES.md` 补 CC-BY-4.0 署名）；K8 `xiangqi-review` 技能 + `.pi/settings.json` 的 `skills` 路径；失败回合 `attempts[]` 记录。
- **验收**：`knowledge.test.ts` 的 12/79 改为新数字且每条路线合法重放；在 `apps/chinese-chess` 下开 `pi`，`/skill:xiangqi-review` 出现在命令菜单（V5）；一局含失败回合的记录能导出 attempts。
- **测试**：CCPD 路线重放；TUI 场景手工验证。

每阶段一个 commit，commit message 说明"为什么"；阶段 1 与 2 之间可以停下来跑几盘真实对局，看 `DecisionTrace` 的 `skillsRead` 是否为空 —— five-llm 的 40 手复盘里模型一次都没主动读额外技能（白皮书 4.7），这是衡量"索引 description 写得够不够好"的第一个信号。

---

## 9. 风险与开放问题

| # | 风险 / 问题 | 影响 | 缓解 |
|---|---|---|---|
| R1 | Pi 不自动输出技能段（5.2），宿主自拼索引；若未来 Pi 版本改变 `formatSkillsForPrompt` 签名或 `<available_skills>` 格式 | 升级 Pi 时提示词变化 | 版本锁 1.4.0；`tests/skills.test.ts` 快照索引格式 |
| R2 | `<location>` 暴露本机绝对路径（V4） | 噪声 + 隐私；five-llm 白皮书 7.2 #4 同类问题 | 自拼索引时用 `path.relative(skillsDir, filePath)`；或接受 |
| R3 | 技能索引常驻后总 token 略增（6.6） | 成本 | 必须与 6.7 的 `analysis` 瘦身一起算总账 |
| R4 | 模型可能不读任何按需技能（five-llm 4.7 的观察） | 技能形同虚设 | 阶段 2 后用 `skillsRead` 统计；description 写"何时用"而不是"是什么" |
| R5 | 路由阈值（受攻大子 ≥ 400、时间 < 60s）拍脑袋 | 剧本选错 | 用三份实战 fixture 校准；`DecisionTrace.playbook` 让复盘能统计 |
| R6 | asar 内 `realpath`（V1） | 打包版加载失败 | `just smoke-dist` 覆盖；失败时回退到 `app.asar.unpacked`（electron-builder `asarUnpack: ["dist/skills/**"]`） |
| R7 | 文案迁出代码后，`expert.ts` 的 `Principle.advice` 变短，L4 专家参谋面板显示的内容也变短 | 用户可见退化 | L4 读 `references/principles.md` 展示全文（界面通道与上下文通道分离，正好符合 L4 约定） |
| R8 | `playbook-*` 用 `disable-model-invocation: true` 隐藏，但 `read_skill` 的 enum 又允许读 | 语义矛盾？ | 不矛盾：隐藏的是"模型自选剧本当作当前流程"，允许的是"读另一份剧本的全文作参考"。在 coach 里写明 |
| R9 | K8 TUI 复盘需要 `read`/`bash`，而 `allowed-tools` 可能不被 1.4.0 执行（V3） | 技能里的脚本调用依赖用户信任 | 复盘技能只读 `records/`，脚本是 `bun scripts/learn.ts` 既有命令 |
| O1 | 剧本切换粒度：回合中途 `search_position` 发现时间变紧，系统提示词里的剧本不会换（five-llm 7.2 #5 同） | 可接受 | 在 `evaluate`-类工具返回里附 `recommendedPlaybook`，与注入的不同时提示 |
| O2 | `principle-*` 要不要像 pstack 那样 24 条？ | 索引膨胀 | 先 6 条；每条一句话；超过 8 条就该合并 |
| O3 | 中文 `name`？ | Pi 要求小写 ASCII（`skills.md:81`） | 名字英文，`description` 中文 |

---

## 10. 需要用户拍板的决策点

| # | 决策 | 选项 | 本文倾向 |
|---|---|---|---|
| D1 | 入口 + 剧本的注入位置 | A. 系统提示词（稳定前缀 + 可变尾部）；B. 用户消息 `/skill:xiangqi-coach …` 展开 | **A**；B 留给 TUI |
| D2 | 剧本集合 | 7 份（含 in-check / under-attack / risk-acknowledgement）vs five-llm 式 4 份 | **7 份**：象棋"被将军"和"大子受攻"是最常见的两种决策情景，值得独立 |
| D3 | `read_skill` 是否允许读剧本 | 允许 / 只允许原则与技能 | **允许**（R8） |
| D4 | K8 `xiangqi-review` 放哪 | `skills/` 内用 `skillsOverride` 过滤 / 放 `.pi/skills/` 只给 TUI | **`.pi/skills/`**：应用与 TUI 用途物理分开，应用的 `EXPECTED_SKILLS` 校验更简单 |
| D5 | `knowledge.ts` 的 `caution` 文案 | 迁 reference / 留在数据里 | **留**：它是随 `KnowledgeHint` 数据一起注入的"局限性声明"，属于信号的一部分（five-llm 的 `limitations` 也在数据里） |
| D6 | 阶段 3 的 `analysis` 瘦身是否并入本次 | 并入 / 单独立项 | **单独阶段但同一 plan**：它解决 P4，不依赖 Skill 化，但验收要一起算 token |
| D7 | 是否现在接线 CCPD（P10） | 阶段 4 / 不做 | **阶段 4**：有授权、已验证坐标，闲置可惜；但要先确认 `KNOWLEDGE-SOURCES.md` 的署名条款 |
| D8 | Package | 不做 / 做 C | **不做**（7.3） |

---

## 附录 A：源码索引（楚河）

| 主题 | 位置 |
|---|---|
| SYSTEM 常量（待拆） | `src/agent/pi-driver.ts:10-24` |
| ResourceLoader 屏蔽项 / `noSkills` | `src/agent/pi-driver.ts:53-59` |
| 工具隔离校验 | `src/agent/pi-driver.ts:69-72` |
| 请求计数 8 | `src/agent/pi-driver.ts:74-77` |
| 回合前自动搜索 | `src/agent/pi-driver.ts:82-89` |
| 用户提示词模板 | `src/agent/pi-driver.ts:91-100` |
| 工具清单 / 预算闸 / 七个工具 | `src/extensions/xiangqi.ts:9`、`:15-22`、`:23-88` |
| `TurnPort` / `AgentDriver` | `src/business/game-service.ts:14-23` |
| `analyze()` 注入 knowledge / experiences | `src/business/game-service.ts:40-47` |
| 提交复查与 `MoveRiskError` | `src/business/game-service.ts:245-287` |
| `TurnNote` 字段 | `src/shared/types.ts:6-7` |
| 原则触发与文案 | `src/business/expert.ts:200-217`、`:258-262` |
| `phaseOf` | `src/business/expert.ts:63-67` |
| `MoveRiskError` 消息 | `src/business/expert.ts:270-275` |
| 定式数据 / 条件棋理 / 来源 | `src/business/knowledge.ts:12-25`、`:64-70`、`:5-8` |
| 动机文案 / 召回建议 | `src/business/learning.ts:13-16`、`:208-245` |
| 计划协议 | `src/business/plan.ts:18-46` |
| 搜索预算 | `src/business/live-search.ts:6-17` |
| 组合根（学习 Worker、搜索 Worker） | `src/electron/main.ts:89-91` |
| 构建复制 | `scripts/build.ts:14-15` |
| 未接线数据 | `src/data/ccpd/openings.json`；`scripts/import-ccpd.ts` |
| 集成测试工具集合断言 | `tests/pi-integration.test.ts:67` |

## 附录 B：Pi 1.4.0 API 速查（本文用到的）

| API / 事实 | 出处 | 状态 |
|---|---|---|
| SKILL.md 字段与约束 | `pi/docs/skills.md:67-85` | 已核 |
| 发现路径（`.pi/skills`、`~/.pi/agent/skills`、`.agents/skills`、`~/.agents/skills`、settings `skills`） | `pi/docs/skills.md:59-63`；`pi/docs/settings.md:150-156` | 已核 |
| 目录发现规则（含 `SKILL.md` 即根、不再下钻） | `pi/dist/core/skills.d.ts:29-34` | 已核 |
| `formatSkillsForPrompt(skills, 'read'|'bash'|'indirect')` 与 XML 格式 | `pi/dist/core/skills.js:278-303`；`pi/dist/index.d.ts:23` | 已核 |
| 技能段只在有 `read`/`bash` 工具时自动生成 | `pi/dist/core/system-prompt.js:101-109` | 已核 |
| `customPrompt` 只替换 `preamble` | `pi/dist/core/system-prompt.js:78-80` | 已核 |
| `noSkills` + `additionalSkillPaths` 只加载指定路径 | `pi/dist/core/resource-loader.js:424-426`、`:626-640` | 已核 |
| `skillsOverride`、`getSkills()` | `pi/dist/core/resource-loader.d.ts:34-36`、`:90-95`；`pi/examples/sdk/04-skills.ts` | 已核 |
| `Skill { name, description, filePath, baseDir, sourceInfo, disableModelInvocation }` | `pi/dist/core/skills.d.ts:9-16` | 已核 |
| `/skill:name args` 展开格式与默认开启 | `pi/dist/core/agent-session.js:1636`、`:1659-1662`、`:1727-1740` | 已核（运行效果 V2 待验证） |
| `enableSkillCommands` 只管命令注册 | `pi/dist/core/agent-session.js:2755-2760`；`settings-manager.js:914` | 已核 |
| `resources_discover` 事件与返回 | `pi/dist/core/extensions/types.d.ts:552-562`；`pi/docs/extensions.md:142` | 已核 |
| Package 目录约定 / manifest / 安装 / peerDependencies | `pi/docs/packages.md:9-27`、`:44-72`、`:80-90` | 已核 |
| `allowed-tools` 是否执行 | `pi/docs/skills.md:78`（实验性） | **待验证**（V3） |
| asar 内技能加载 | — | **待验证**（V1） |
| 本地目录直接作为 package 被 TUI 发现 | `pi/docs/packages.md:40` | **待验证**（V5） |
