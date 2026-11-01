# L3 技能组重构实施与验收

> **历史记录（v1/v2）**：下文保留首版实现与当时验收，不再代表当前架构。v3 已删除 `skill-loader.ts`、`SkillCatalog`、专用 `read_skill`、宿主索引和全文拼接，改用 Pi 原生 Skill 与 `read/bash/edit/write`。宿主只给剧本建议；当前边界与记录语义见 [原生 Skill 与内置工具](native-skills.md)。原验收数字不作为 v3 的验收结论。

依据 `discussions/2026-10-30-refactor-chinese-chess-pi-skills.md`，采用 D1–D8 推荐项：系统提示词注入、七剧本、允许按需读取其他剧本、TUI 复盘物理隔离、保留 caution、同计划独立瘦身阶段、接线 CCPD、不发布 Pi package。

## 边界

规则/棋钟/权威提交审查不改变；L3 不依赖 Pi/Electron。文本用 Pi SKILL.md，发现/校验/frontmatter/索引用 Pi API，不复制解析器。不开放文件系统工具。版本 `xiangqi-skills/v1`；知识不宣称提升棋力。

## 顺序与验收

1. 入口及 references → 六原则 → 五专项技能。
2. 原生加载器：集合完整、diagnostics 空、用户/项目技能不混入；引用拒绝 traversal 和 symlink 越界；索引用逻辑相对路径，不泄露安装路径。
3. 驱动注入入口和索引、构建复制技能。缺文件显式失败，不停钟。
4. 七剧本 → 纯路由（终局、应将、余时、大子、阶段）→ 逐手审计端口 → enum read_skill → 驱动真实事件。默认仅注入入口和一份剧本，注入和读取分开记。
5. 文案迁移保留事实触发与局限；桌面展示与模型上下文分离。精简工具描述、风险错误及首次请求 signals，三份固定局面首次提示词相对全量报告下降至少 40%。
6. CCPD 64 个抽样文件中接受的61条路线合法重放与授权署名，保留3条拒绝；TUI-only 复盘；更新人读文档。
7. typecheck、全量离线测试、build、开发烟测、打包 asar 烟测。

审计必须在权威提交创建 TurnNote 之前取得，包括本次成功 commit；不能指望提交之后的 tool_execution_end 才补写（会错过原子保存）。其他工具使用真实 tool_execution_end，提交结果在业务成功事务内完成，失败不伪报成功。

首版暂缓的可选失败回合 attempts[] 已在后续[耗时诊断](turn-latency.md)中独立落地，覆盖取消/超时生命周期、无revision变化时的保存与最近80项保留策略。失败工具调用仍保存在成功回合的工具序列内。

## 基线

- TypeScript 检查通过；110 tests / 0 fail。
- Pi 1.4.0 导出 loadSkillsFromDir、formatSkillsForPrompt、stripFrontmatter；复用其解析功能。
- 现有 UI smoke 使用非 LLM fixture，因此需额外在 Electron 主进程验证技能加载，不能把 UI fixture 误报为真实 Pi asar 加载测试。

后续耗时诊断将当前技能版本升级为 `xiangqi-skills/v2`，旧v1决策记录仍可读取；下列为首版实施记录，当前测量与验收见 [turn-latency.md](turn-latency.md)。

## 已实施

- 19项应用技能；Pi负责发现、校验、去frontmatter和索引格式。索引11项（原则和专项）；入口与当前唯一剧本注入全文。19项均可通过enum读取，TUI-only review不在应用集合。
- 引用只接受平面小写Markdown文件名；真实路径验证拒绝路径遍历、绝对路径、缺失文件与symlink逃逸。用户/项目/设置注入的外来技能不加载。
- decision纯路由覆盖真实fixture所有前缀；应将优先于时间，时间优先于受攻大子。初始局面的隔子炮可合法攻击马，因此初始路由可能是under-attack，测试不把它误当作无威胁的opening。
- TurnNote的decision在成功提交事务内完整产生（包括本次move_piece成功），失败工具保留顺序；注入与读取分离，不根据模型reason猜测工具执行。失败/取消的整回合attempts后来已按独立耗时诊断设计落地。
- L3保留触发条件、id/evidence、简短advice和caution/limitations。全文迁入references；L4在构建时从同一Markdown加载全文，不引入新的IPC或文件系统权限。学习动机以稳定ID传输，UI从同源references显示中文解释。
- 风险错误上下文仅四个字段和技能提示，完整review保存在工具details；送车纠错回归仍通过。
- 首次请求仅投影signals，不修改完整业务分析。六候选、受攻己子、紧凑搜索、唯一plan；完整合法走法和报告按需读取；摘要保留最近20手及吃子手。
- CCPD实际61条接受+3条拒绝（非标准初始局面），并非讨论稿所称64条均已导入。总计73路线/1360节点/7来源，保留许可、署名、固定commit、逐文件hash、修改说明并随asar分发。

## 验收结果

- `just check`：TypeScript、128项离线测试（0失败）、生产构建通过；`git diff --check`通过。
- `just smoke`：真实Electron开发版全部UI、棋钟、Worker、隔离IPC、原子保存检查通过。
- `bun run pack` + `just smoke-dist`：mac-arm64 ad-hoc签名app打包及同一套烟测通过。烟测启动时额外在Electron主进程运行SkillCatalog、Pi DefaultResourceLoader（noSkills+additionalSkillPaths）、getSkills集合/diagnostics断言及reference读取；确认asar的readdir/realpath/fs链路，无需asarUnpack。UI走子本身仍是明确标注的fixture，不冒充真实模型。
- 本地SSE通过真实Pi会话验证八工具隔离、读取全文/引用、enum与越界拒绝、失败/成功调用顺序、8请求和16工具预算、异步提交、超时取消、旧棋谱兼容。
- 固定预算首次system+user字符回归（相同技能系统前缀，与阶段1全量报告注入形态比较，不含工具schema）：初始约26665→9316（65%）；human-mistakes第42手前约32881→11668（65%）；passive第53手前约36994→12049（67%）。字符统计不是token或费用承诺，耗时字段可有少量波动。精简SYSTEM本身约170字；技能索引新增开销不单独声称下降。
- Pi TUI复盘技能通过原生发现/diagnostics测试；交互命令菜单与真实模型主动读取频率尚需人工实战验证。`allowed-tools`不作为权限控制。不发布Pi package，不对棋力作声明。

