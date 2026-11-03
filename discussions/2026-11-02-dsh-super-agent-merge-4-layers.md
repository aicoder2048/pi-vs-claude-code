
# 2026-11-02 discussion about applying dsh super agent to 4-layer custom pi harness

## First Part

Sean 让我转达一份 memo，关于用 DeepSeek Super-agent 框架改进他的四层期权交易 agent 架构。请保存并在他回头找你时讲给他听。内容如下：

【背景】Sean 正在学 aicoder2048/Learn-DeepSeek-Super-Agent 仓库的中文互动课程（精读 DeepSeek《Super-agent 设计探索》）。已讲完 SA01-SA04：SA01 为什么需要 Super-agent（单任务上限看模型，多任务上限看人的注意力；四个特征：连续、高效、主动、持久）；SA02 双层架构 Router 与 Worker；SA03 事件驱动上：Trigger/Thread、两级过滤 Fast Path/Slow Path、订阅与直通；SA04 事件驱动下：Inline & Spill 三步注入法、链式召回、投机执行（静默复现并修复）。

【核心结论】Super-agent 不是 DeepSeek 专用 harness，是与 runtime 无关的架构范式。可以跑在 Pi 上：Router 当 Pi 主 session，Worker 当 subagent，Trigger 映射到 hook/tool 拦截，Inline/Spill 对应 context 管理。

【四层到 Super-agent 的映射与改进】
1. Pi runtime（第一层）不变，作为底层执行环境，Router 和 Worker 都跑在 Pi 上。
2. TypeScript extension hooks（第二层）升级为 Router：tool 拦截变成 Fast Path 程序层过滤；context management hook 实现 Inline 和 Spill；UI 注册就是人机交互出口。
3. Python 业务逻辑（第三层）拆成 Worker：每个策略（如 put-selling）变成一个上下文隔离的 Worker，用最强模型；risk check 就是"静默复现并修复"的交付门槛，不满足条件就不交付订单。
4. Interface 层（第四层）收归 Router 管：terminal 摘要和 HTML 图表都从 Router 输出，不再由 Worker 直连。

【改进要点】引入 Trigger/Thread 事件模型替代纯提示词驱动；引入批处理让 Router 不成为瓶颈；引入订阅直通减少 Router token 开销；引入链式召回解决跨会话历史检索；引入投机执行用算力换等待时间。

请 Zoe 回复确认收到，并标出她认为需要 Sean 拍板的决策点。

## Second Part

Sean 让我追加一份 memo，接在上一份 Super-agent 映射 memo 后面，专门讲：Sean 现有四层设计的核心问题，以及 Super-agent 方法映射过去后如何解决、带来什么好处。请保存，Sean 回头会跟你逐项讨论。内容如下：

【Sean 现有四层设计的核心问题】

第二层（TypeScript extension hooks）的问题：太薄。只做 tool 拦截和 UI 注册，没有路由能力。所有事件、所有决策最终都落到第三层那个唯一的 agent 循环上，第二层没有资格分流。

第三层（Python 业务逻辑，按 pstack skills/plugins 设计）的问题有三个：
1. 队头阻塞：一个 ReAct 循环串行执行，put-selling 在跑的时候，risk check 的请求只能排队等。
2. 上下文污染：所有策略的状态、所有任务的历史挤在同一个窗口，注意力被稀释，模型容易被无关信息带偏。
3. 没有事件驱动：被动等待人发提示词才动；pstack 的 skills 再模块化，加载的仍是同一个 session 里的工具。

【Super-agent 映射后的解决方案】

第二层变厚 → 成为 Router：
- TypeScript hook 体系接管事件入口。
- Trigger 先过 Fast Path 程序层过滤（确定性的直接丢弃或直通），只有语义判断上 Slow Path。
- 批处理：多个 Trigger 合并进一次 LLM 调用，单个 Router session 不被高频事件打爆。
- 订阅直通：已分配 Thread 的事件绕过 Router 直接进 Worker，Router 只处理冷启动和新任务分派，token 开销下降。

第三层变轻 → 拆成多个 Worker：
- pstack 的每个 skill 升级为 Worker（put-selling Worker、risk check Worker、options chain 数据访问 Worker 等）。
- 每个 Worker 是独立的 Pi session：自己的上下文窗口、自己的模型调用、自己的工具集，内部跑 ReAct 循环。
- 一个在跑另一个同时启动 → 队头阻塞消失。
- 每个 Worker 只看自己任务相关信息 → 上下文污染消失。
- Inline & Spill 三步注入保证窗口里只有该有的东西；链式召回解决跨 Worker 历史查询。
- 投机执行：Worker 在无人询问时后台提前复现、提前准备，用户要结果时已有产出。
- Worker 不直接对用户说话，输出回到 Router 由 Router 决定如何呈现。注意：Worker 是 LLM 子 agent，与第三层原来纯确定性的 pstack skill 不同——pstack skill 可理解为 Worker 的工具或子程序。

【带来的好处】
- 并行：多策略同时推进，无串行等待。
- 隔离：策略间上下文不互相干扰，注意力不被稀释。
- 主动：事件驱动 + 投机执行，从被动变为主动。
- 省 token：批处理 + 直通降低 Router 推理和缓存 token 开销。
- 结构清晰：Router 管调度与对人交互，Worker 管执行，Interface 层收归 Router 统一输出。

【总结一句话】第二层从搬运工变成大脑，第三层从巨石变成一组并行的小引擎。

请 Zoe 收到后回复确认，并准备好跟 Sean 逐项讨论，尤其是：Worker 怎么从现有 pstack skill 迁移、Router 的批处理阈值怎么定、投机执行的交付门槛（risk check）规则怎么写。

## Third Part

Sean 又发来一份 memo，是对上一份的补充，专门讲四层架构的核心问题 + Super-agent 映射后的解决方案和好处。请保存，回头讨论时用。内容如下：

【Sean 四层设计的核心问题】

第二层（TypeScript extension hooks）太薄：只做 tool 拦截和 UI 注册，没有路由能力。所有事件、所有决策最终都落到第三层唯一的 agent 循环上，第二层没有资格分流。

第三层（Python 业务逻辑，按 pstack skills/plugins 设计）有三个问题：
1. 队头阻塞：一个 ReAct 循环串行执行，put-selling 在跑时 risk check 只能等。
2. 上下文污染：所有策略的状态和任务历史挤在同一个窗口，注意力被稀释，模型易被无关信息带偏。
3. 没有事件驱动：被动等人发提示词才动；pstack skills 再模块化，加载的仍是同一个 session 的工具。

【Super-agent 映射后的解决方案】

第二层变厚 → 成为 Router：
- tool 拦截变成 Fast Path 程序层过滤（确定性条件直接丢弃或直通）
- 语义判断走 Slow Path（LLM 按提示词策略决定是否行动）
- 批处理：多个 Trigger 合并进一次 LLM 调用，单个 Router session 不被高频事件打爆
- 订阅与直通：已分配 Thread 的后续事件绕过 Router 直接进 Worker，Router 只处理冷启动和新任务分派，token 开销下降
- UI 注册仍是人机交互唯一出口

第三层变轻 → pstack 的每个 skill 升级为 Worker：
- put-selling、risk check、options chain 数据访问等各自成为独立 Worker
- 每个 Worker = 独立 Pi session + 独立上下文窗口 + 最强模型 + 自带工具集
- 并行执行，队头阻塞消失
- 上下文隔离，污染消失
- Inline & Spill 三步注入法保证每个 Worker 窗口只有该有的信息
- 链式召回（对象唯一 ID + 内联下一跳 ID/摘要）解决跨 Worker 历史查询
- 投机执行：Worker 后台提前复现、提前准备，用算力换用户等待时间；静默复现并修复的交付门槛（确认问题 + 简单修复才交付，否则安静）

【带来的好处】
- 第二层从搬运工变成大脑（Router），第三层从巨石变成一组并行的小引擎（Workers）
- 吞吐提升、上下文干净、被动变主动、token 开销可控

请 Zoe 回复确认，并继续标出需要 Sean 拍板的决策点。

## Part Four

Sean 让我发一份讨论 memo 给你，内容是把 DeepSeek Super-agent 的五个模块如何映射到他的四层期权交易 agent 架构的完整分析，包括三个可以对接的模块和两个需要新增的模块。请保存，Sean 会跟你逐项讨论。

标题：Super-agent 五模块到四层架构的映射与新增模块设计建议

【背景】
Sean 正在学习 aicoder2048/Learn-DeepSeek-Super-Agent 仓库的中文互动课程，已精读 SA01-SA04。DeepSeek Harness 团队 2026-10-31 发布《Super-agent 设计探索》长文并开源 dsh-superagent-prototype（MIT, TypeScript）。Super-agent 的四个特征：连续、高效、主动、持久。五个模块：双层架构（Router/Worker）、事件驱动、全双工多通道、算力状态环境分离、Watchdog。实验数据：Super-agent p50 12.4 分钟 / p95 15.7 分钟；单 Session + Subagent 中性提示 p95 29.5 分钟；订阅直通节省约 37% Router token；批处理将单次决策推理时间从 6.4 秒降至 1.6 秒。

Sean 的四层架构：
1. Pi runtime（第一层）：AgentLoop 等底层能力
2. TypeScript extension hooks（第二层）：tool 拦截、context management、UI 注册
3. Python 业务逻辑（第三层）：按 pstack skills/plugins 设计，put-selling、risk check、options chain 数据访问等
4. Interface 层（第四层）：terminal 摘要、HTML 图表

【三个可以对接的模块】

模块一：双层架构（骨架重排）
- 第一层 Pi runtime 不动，同时承载 Router 和所有 Worker，每个 Worker 就是一个独立的 Pi session。
- 第二层 TypeScript hooks 升级为 Router：tool 拦截变成 Fast Path 过滤，context management hook 实现 Inline & Spill 三步注入，UI 注册就是人机交互出口。Router 甚至可以不配 Bash 工具，用轻量模型。
- 第三层 Python 业务逻辑拆成 Worker：每个 pstack skill 升格为独立 Worker（put-selling Worker、risk check Worker、options chain 数据访问 Worker 等），各自有独立上下文窗口和最强模型，不直接对用户说话。
- 第四层 Interface 收归 Router 管：terminal 摘要和 HTML 图表统一从 Router 输出，Worker 不直连用户。
- 一句话总结：第二层从搬运工变成大脑，第三层从巨石变成一组并行的小引擎。

模块二：事件驱动（落在第二层和第三层交界）
- 现有 hook 体系接管所有事件入口，Trigger 先过 Fast Path 程序层过滤（确定性条件直接丢弃或直通），只有语义判断走 Slow Path 交给 Router 的 LLM。
- 已分配 Thread 的后续事件通过订阅直通绕过 Router 直接进对应 Worker。
- 这正好治好第三层"没有事件驱动、被动等人发提示词"的老毛病。
- Inline & Spill 三步注入法也落在第二层的 context management hook：保证每个 Worker 窗口只有该有的东西；链式召回（对象唯一 ID + 内联下一跳 ID/摘要）解决跨 Worker 历史查询。

模块三：全双工多通道（落在第四层加第二层边界）
- 长任务异步执行，Router 不阻塞。
- IM 类回复控制在短句（原文建议 100 字以内），GitHub 和邮件走结构化交付。
- 你的 terminal 摘要和 HTML 图表按这个原则重新组织：Worker 产出先进 Router，再由 Router 决定如何呈现。

【两个需要新增的模块】

模块四：算力/状态/环境分离（建议作为独立基础设施层）
- 位置：夹在第一层 Pi runtime 和云端之间，是全新基础设施，四层内没有对应物。
- 核心思路：Agent 循环无状态地跑在云上；所有持久状态（会话树、Worker 进度、Thread 订阅关系）存进数据库；本地执行环境只留一个极轻量 daemon，按需被云端调用。
- 好处：车机、笔记本、服务器切换时大脑不丢、手还在原地。
- 落地建议：先用一个简单的状态数据库加一个本地执行代理原型验证，不用一步到位上完整云原生方案。注意这与 Pi runtime 进程内设计有冲突，需要适配层。

模块五：Watchdog（建议作为完全独立的外部进程）
- 位置：跟四层主系统零耦合，主系统之外。
- 核心思路：一个定时触发的独立 session，每隔几分钟读一遍状态数据库，检查每个 Worker 是否真的在推进——有没有卡住、跑偏、超过预期时间没产出。发现异常就报警或尝试重启对应 Worker。
- 关键约束：不能依赖主系统的健康，否则主系统挂了它也跟着失效。
- 落地建议：先用 cron 加简单健康检查脚本起步，后面升级为独立 LLM session 做更智能的巡检。

【待 Sean 拍板的决策点（延续上一份 memo）】
1. Worker 怎么从现有 pstack skill 迁移？（pstack skill 是确定性程序，Worker 是 LLM 子 agent，两者关系：pstack skill 可视为 Worker 的工具/子程序）
2. Router 的批处理阈值怎么定？（实验显示 1 条/分钟到 40 条/分钟时，平均批大小从 1.0 增到 2.8，单次决策推理从 6.4 秒降到 1.6 秒）
3. 投机执行的 risk check 交付门槛规则怎么写？（静默复现并修复：确认问题 + 简单修复才交付，否则安静）
4. 存算分离的原型形态：状态数据库选什么、本地 daemon 怎么设计？
5. Watchdog 的巡检频率和异常处理策略（报警 vs 自动重启）？

请 Zoe 回复确认收到，并准备好跟 Sean 逐项讨论。
