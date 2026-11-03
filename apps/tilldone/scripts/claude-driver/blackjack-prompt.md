/skill:poteto-mode 在当前工作目录 /Users/szou/Python/Playground/DoorBird/Apps/blackjack 从零构建一个经典 21 点（Blackjack）Electron 桌面游戏，架构仿照 five-llm 的四层 Harness。

## 参考实现（只读，不要修改）
/Users/szou/Python/Playground/LearnTopEngSkills/practice/harness-dual-loops/vendor/pi-vs-claude-code/apps/five-llm
先读 docs/five-llm-whitepaper.md 的第 2 章（四层架构）和第 3 章（双循环与 L2 接入点），再看 src/ 的目录结构、package.json、scripts/build.ts、tests/ 的写法，照它的模式来。

L3 业务层（知识层）的设计参考 chinese-chess（只读）：
/Users/szou/Python/Playground/LearnTopEngSkills/practice/harness-dual-loops/vendor/pi-vs-claude-code/apps/chinese-chess
重点读 docs/chinese-chess-whitepaper.md 第 5 章（L3 业务层：知识怎样变成推理信号，尤其 5.1、5.3、5.4、5.5、5.6、5.7、5.9）和第 6 章，以及它的 skills/ 目录。它的骨架来自 pstack 的“原则索引 → 编排入口 → 剧本 → 技能 → 工具证据 → 验证”，pstack 本身的 skills 在 .pi/npm/node_modules/pi-pstack/skills/ 可对照。

## 游戏设计
- 一张牌桌：真人玩家 + 一个 LLM 玩家（AI 同桌）各自下注、各自对抗庄家。
- LLM 玩家的每个决策（下注额、要牌 / 停牌 / 加倍 / 分牌）都必须通过 Pi 工具调用提交，不能由代码代打；它要给出一句公开理由，显示在界面上。
- 庄家是确定性代码（L3），不经过 LLM。
- 规则：6 副牌牌靴，洗牌点 75%；庄家软 17 停牌（S17）；Blackjack 赔 3:2；任意两张可加倍；可分牌一次（分 A 只发一张）；不支持投降和保险；平局退注。每位玩家初始 1000 筹码。

## Pi 接入方式：外部 pi CLI + RPC 子进程，不用 SDK
**不要用进程内 Pi SDK，不要 import 或依赖 @earendil-works/pi-coding-agent / pi-ai。** 这一点和 five-llm 不同，要照 tilldone 的方式：
/Users/szou/Python/Playground/DoorBird/Apps/tilldone（只读参考：README.md 的 Four layers / RPC details 两节，src/rpc.ts、src/jsonl.ts、src/config.ts，test/fake-pi.ts，以及 extensions/tilldone/ 这个被 `-e` 加载的扩展）。
- 宿主用 `spawn("pi", ["--mode", "rpc", "--no-extensions", "--model", <model>, "-e", <app>/extensions/blackjack, "--no-skills", "--skill", <app>/skills])` 启动外部 pi 子进程，stdin/stdout 走 JSONL（`prompt` / `abort` / 带 id 的命令和 response、事件流）。
- Pi 扩展文件放在 `extensions/blackjack/`，由 `-e` 加载，运行在 pi 子进程里；它注册领域工具。扩展可以 import 零依赖的 L3 纯函数（像 tilldone 宿主 import 扩展的 state.ts 那样共享纯代码），但不能 import Electron 或宿主 L2。
- 跨进程的数据流要自己设计清楚并写进 README：宿主怎样把当前牌桌快照交给模型（例如放进 prompt 消息），LLM 的决策怎样回到宿主（例如 commit 工具在 tool result 的 details 里返回结构化动作，宿主从 RPC 事件流读取后交给 GameService）。**宿主 L3 永远是权威**，收到的动作必须重新校验合法性，不合法就拒绝/重试，不能信任子进程。
- 每个决策要有干净的上下文（例如 RPC 的新会话命令，或重启子进程，任选并说明理由）；有请求/工具调用预算、技术超时、abort 取消。
- pi 可执行文件路径用环境变量覆盖（例如 BLACKJACK_PI_BIN），测试用一个假 pi 脚本（照 tilldone 的 test/fake-pi.ts）跑真实管道，不调用真实模型。

## 四层（对照 five-llm 的分层原则，但 L1 换成 RPC 子进程）
- L1 平台：外部 pi 进程（RPC 模式）+ Electron 运行时，原样使用。
- L2 胶水：宿主侧 RPC 客户端（spawn、JSONL 编解码、id 关联、超时、生命周期）+ `extensions/blackjack/` Pi 扩展（领域工具，如 observe_table、evaluate_hand、commit_action；tool_call 预算闸和“先观察再提交”的门禁）。
- L3 业务：纯 TypeScript，零依赖，不 import Pi 或 Electron。牌靴/发牌、软硬 A 点数、合法动作、庄家规则、结算、筹码；GameService 单写者；TurnPort / AgentDriver 端口（依赖倒置）。L3 还负责“什么进上下文、进多少、以什么形式进”，见下一节。

## L3 设计需求（参考 chinese-chess 第 5 章 / pstack）
1. **知识按可信度分类安放**（照 chinese-chess 5.1 的表）：硬规则（代码：牌点、合法动作、庄家 S17、结算、筹码、一次提交）→ 确定性事实（代码：当前点数/软硬、可选动作、庄家明牌、剩余牌靴构成、本靴已出牌）→ 有界计算（代码：按当前牌靴精确或有界计算各动作的期望值/爆牌概率，并标注 coverage 和 limitations）→ 启发式（基本策略表、Hi-Lo 真数，随结果附 limitations）→ 流程知识/专家经验（skills/**/SKILL.md）。冲突时优先级：代码规则 > 当前计算事实 > 有界启发式 > 技能经验，写进入口技能。
2. **Pi 原生技能组**，放在 `skills/`，标准 Agent Skills 格式（name 与目录同名，description 写“何时用”，正文“步骤 → 证据 → 局限”）：
   - 入口 `blackjack-coach`（相当于 poteto-mode）：observe → compare → commit 的流程、路由与预算说明。
   - 若干 `principle-*`（如 rules-first、facts-over-heuristics、bankroll、single-commit），一句话原则。
   - 若干 `playbook-*` 情景剧本（如 betting、hard-total、soft-total、pair-split、double-down、low-bankroll），`disable-model-invocation: true`，由宿主路由，模型不能自选。
   - 若干专项技能（如 read-table-signals、basic-strategy、card-counting、expected-value），可带 references/。
   - **用 Pi 原生机制加载，不要自建 skill loader / read_skill 协议**（chinese-chess 5.4 的设计更正）：pi 子进程加 `--no-skills --skill <app>/skills`，模型用原生 read 按需读全文；入口用 RPC prompt 发 `/skill:blackjack-coach <本回合快照>` 由 Pi 展开。请实际验证 `--no-skills` 下 `--skill` 仍然生效。
3. **宿主确定性路由**（chinese-chess 5.5）：纯函数 `turnGuidance(state)` 每个决策选一个剧本（例如 下注阶段 → betting；可分牌 → pair-split；软点 → soft-total；硬点 → hard-total；筹码低 → low-bankroll），有测试覆盖。
4. **信号契约**（chinese-chess 5.6）：`turnSignals(state)` 是只读投影，只给模型做这个决策需要的字段，每个字段能回答“它帮模型做哪个决策”；局限（coverage、limitations）写在数据里。不要把整副牌靴或无关历史塞进上下文。
5. **证据链 DecisionTrace**（chinese-chess 5.7）：记录本回合 revision、宿主选的剧本、注入的技能、工具调用序列（含失败）、observe/compare/commit 各步是否完成，由代码登记而不是模型自述；随手牌历史保存，界面可查看。
6. **提交时独立复查**：不管模型有没有调用计算工具，commit 时 L3 都独立校验合法性；若动作明显劣于基本策略（例如硬 20 要牌），记入 trace 的风险说明，但不替模型改决定（模型可以给理由偏离）。
- L4 Electron：main.ts 组合根、IPC 校验；渲染器显示牌桌、手牌、筹码、当前轮到谁、LLM 的理由和工具调用链路日志；真人玩家用按钮操作。

## 约束
- 默认模型 openai-codex/gpt-6.1-sol；任何 anthropic/* 模型必须在启动前拒绝（按量计费，没有余额）。
- bun + TypeScript，构建方式参照 tilldone 的 package.json（bun build 出 main.cjs / preload.cjs / renderer.js），不加 Pi SDK 依赖。
- 测试：bun test 覆盖 L3 规则（点数、庄家 S17、结算、分牌/加倍）、L2 扩展工具和 RPC 客户端（用假 pi 脚本跑真实管道，绝不调用真实模型）；提供一个用假 pi 的 Electron smoke 测试。
- justfile：install / start / test；README.md 说明四层结构和运行方法。
- 不要 git push，不要修改或删除本目录以外的任何文件。

## 完成标准
bun install 成功；bun run typecheck、bun test、bun run build 全部通过。完成后汇报文件结构、测试结果，以及还没做或有风险的地方。
