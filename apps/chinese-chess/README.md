# 楚河 · 中国象棋（对弈大模型版）

参考相邻的 `five-llm`，实现的独立 Electron 中国象棋桌面应用。木质楚河汉界棋盘、32 枚立体棋子、背景配乐、棋钟、三局两胜、棋谱回看，以及**真正通过 Pi Agent Harness 工具调用走棋的大模型**。没有用本地搜索引擎冒充 LLM，也不从模型自然语言里猜坐标。

## 启动

需要 Bun、Node.js ≥ 22.19 和可运行 Electron 的图形桌面。

```bash
# 在 pi-vs-claude-code 仓库根目录
just chinese-chess

# 或在应用目录
cd apps/chinese-chess
just chinese-chess
```

首次启动自动安装依赖、构建并打开桌面；以后可用 `just start`。关闭窗口、Cmd+Q 或 Ctrl+Q 都会退出，不留下常驻后端。

### 模型与认证

直接复用 Pi 的 `~/.pi/agent/auth.json`、`models.json` 和 provider 环境变量；支持 `PI_CODING_AGENT_DIR`。不需要运行 Pi TUI 或另启服务。没有认证时先在 Pi 中 `/login`，然后重启本应用。

默认模型与 `five-llm` 保持一致，为 `gpt-6.1-sol`，优先 `openai-codex`。不存在时明确提示手动选择，**不会静默切换到其他模型**。可在界面选已认证模型，或指定：

```bash
CHINESE_CHESS_MODEL='provider/model-id' just chinese-chess
```

API Key 也可通过 `OPENAI_API_KEY` 等 Pi 支持的环境变量提供。OpenAI Codex 的 OAuth 登录与 OpenAI API Key 是不同 provider。本地 OpenAI-compatible 模型可照常配置在 Pi 的 `models.json` 中，但必须支持工具调用。

调用可能产生 API 费用，模型强度不保证。密钥只在主进程中使用，不发给渲染器。应用使用 `@earendil-works/pi-coding-agent` / `pi-ai` **1.4.0**，与参考应用一致。

### Mac 安装包

```bash
cd apps/chinese-chess
just dist          # → release/chuhe-1.0.0-mac-arm64.dmg（Apple 芯片）
just smoke-dist    # 在打包后的 楚河.app 上跑同一套桌面 smoke
```

由 electron-builder 生成，内含 Electron 与 Pi SDK，使用者无需安装 Bun 或 Node。但模型认证仍读使用者本机的 `~/.pi/agent/`：对方需要先安装 Pi 并 `/login`（或提供 API Key 环境变量），否则只会提示未发现模型。

签名与安全：

- 本机没有 Developer ID 证书，因此**只做 ad-hoc 签名，未经 Apple 公证**。签名覆盖整个 `.app`（含 `_CodeSignature/CodeResources`），从 DMG 拷出后 `codesign --verify --deep --strict` 仍然通过。不要对 `.app` 做二次修改或用会丢签名的方式重新打 zip；需要 zip 时用 `ditto -c -k --keepParent 楚河.app 楚河.zip`。
- 打包时删除了 Electron 默认的 `NSAppTransportSecurity`（`NSAllowsArbitraryLoads` 及 127.0.0.1 明文 HTTP 例外），见 `scripts/after-pack.cjs`。应用只访问 HTTPS 模型接口。
- 从微信、邮件或浏览器收到的副本带隔离标记，Gatekeeper 会拒绝。对方确认来源可信后，在「系统设置 → 隐私与安全性」点「仍要打开」，或执行 `xattr -dr com.apple.quarantine /Applications/楚河.app`。这等于绕过 Gatekeeper，只应对信任的发送者这样做；每个新版本都要重新放行。
- 正式对外分发需要 Developer ID 签名 + `notarytool` 公证（electron-builder 的 `mac.identity`、`hardenedRuntime` 与 `notarize` 配置），目前未做。

## 棋局与桌面功能

- 经典 9 × 10 棋盘：楚河汉界、九宫斜线、兵炮位置标志、红黑汉字棋子。黑方执棋时自动翻转，也可手动翻转。
- 点己方棋子再点目标位置。绿点为合法移动，红圈为可吃子；禁止自将、将帅照面和不应将。
- 支持方向键移动光标，Enter / 空格选子与走子，Escape 清除选择。
- 默认 **三局两胜**，可选五局三胜；胜负局后交换红黑，和棋不计胜场、同色重赛，双方重新配时。
- 默认 **每方每局 50 分钟 + 每步加 20 秒（Fischer）**，参考 [2026 全国象棋个人赛决赛慢棋规程](https://www.sport.gov.cn/qpzx/n5387/c30123103/content.html)；也可选择包干制，自定义局时和加秒。
- 权威棋钟在 Electron 主进程。模型思考和网络等待计时；取消请求、重试、换模型、回看、打开设置均不停钟。到时判负，迟到走子拒绝。
- **不另设单步时间上限**，已取消固定 90 秒模型回合技术超时；可以长考，但必须在自己的剩余棋钟耗尽前完成落子。棋钟到时会中止模型 / 搜索并判负。供应商或网络错误仍会提示重试、换模型或认输，棋钟不停，不自动替走。
- 默认不允许悔棋，可开启练习悔棋。悔棋撤回到人类上一手之前，不返还时间，不在悔棋操作时奖励加秒；已结算局不可悔棋。
- 棋谱逐手回看、滑条浏览、回到实战；回看不能走子。公开 LLM 落子理由与耗时，不展示私有思维链。
- 「专家参谋 / 战术报告」可查看受攻击棋子、几何保护与牵制、阶段棋理、候选的对方反击和计算覆盖；回看使用该手已保存的报告。
- 四层链路与工具日志可在页脚展开。JSON 导出包含完整棋谱、吃子、逐手专家分析、理由、最终走法复查、明确接受风险的说明、时钟、终局原因和比赛比分。
- 已验证 1280×900、1100×760、1010×700 窗口无整页滚动，棋盘随可用高度缩放；较短窗口会收起模型旁的说明文字。

### 动画和声音

走子平滑滑动、马走子轻跳，吃子有棋子飞散、涟漪、粒子和「隔山打炮 / 马到功成」提示，将军时提示「将军」并标记受将的将帅。动画可以关闭，并尊重系统减少动态效果设置。走子有轻音效，可独立关闭。

两首本地完整 MP3：萨蒂《Gymnopedie No. 1》、电钢琴 / 萨克斯《Night on the Docks - Sax》。默认暂停、12% 音量，播放 / 暂停及切换有淡入淡出，无需联网。录音由 **Kevin MacLeod (incompetech.com)** 提供，采用 **CC BY 4.0**；保留参考应用的原始授权资源。完整署名、来源、授权与 SHA-256 见 [`ATTRIBUTION.md`](src/renderer/assets/music/ATTRIBUTION.md)，界面 ⓘ 也可查看。

## 业务层专家 Know-how

新增 `src/business/expert.ts`，不是只增加棋诀提示词：

- 根据实际棋盘计算合法吃子、几何保护、移子暴露将帅的牵制，以及马的合法落点和士象防线。
- 按开、中、残局触发附证据与例外的棋理；子力价值随阶段变化，车路和马的活动性参与位置评估。
- 候选走子后枚举对方应手，检查一步杀 / 困毙，进行有预算的同格连续交换，输出具体反击变化。
- 新增 `review_move`、`compare_moves` 工具，避免模型仅靠假设对手配合来试算。
- 每次机器提交都会在业务层独立复查；明显亏子或直接败着先反馈风险。真正的弃子仍可由模型明确说明补偿后提交，不静默替走。
- 显式区分规则事实、有限反例与启发式估计；预算未覆盖不是安全结论。
- **实战多步搜索**：新增 `search_position`，迭代加深、将军 / 唯一应将延伸和吃子 / 应将静态搜索；模型请求前自动搜索，最终落子独立搜索实际候选。桌面端使用可取消 Worker，预算截断只保留最后完整迭代。
- **局面评价**：出子、活动性、九宫周边多子协同、九宫线牵制和无效往返使用小权重排序；不以将军次数或盲目前进奖励进攻，原有防送子审查保留。
- **连续计划**：新增 `update_plan`，保存当前问题、目标、对方计划、近期步骤与放弃条件；每回合明确继续 / 修订 / 放弃。计划只随成功落子持久化，将军、对方吃子或 8 半回合过期后失效；悔棋、换模型、新局清空。

那盘实战的「平车送车」和「贪兵丢炮」已加入独立回归，分别识别 −900 与 −350 的交换损失。完整机制、性能预算和局限见 [EXPERT.md](EXPERT.md)。

## 成型知识 + 赛后学习闭环

- 内置首批 **12 条公开定式示例、79 个路线节点（含重合）**，带出处、计划、适用条件和例外；只有全盘局面吻合且候选复核通过才注入模型，偏离定式不硬套。
- 每局结束并保存后，独立 Worker 自动复盘双方走法，验证局部反例和较安全替代，避免卡住主进程棋钟。
- 验证案例去重后持久保存，下一局按“避免自己犯错 / 抓住对方失误”检索，并按当前棋盘重验；未验证候选不注入。
- 「复盘 / 案例库」查看进度、历史复盘和候选；启动自动回填已有完整棋谱，也可手动点「回填已有棋谱」。
- 原有两盘已回填为 11 条局部验证案例，原棋谱未改动。该机制不训练模型权重，也不声称已经达到专业引擎棋力。

详细闭环、持久化、资源上限与后续路线见 [LEARNING.md](LEARNING.md)，网上资料和授权边界见 [KNOWLEDGE-SOURCES.md](KNOWLEDGE-SOURCES.md)。应用运行时不会向这些知识网站上传棋谱。

## 四层结构

```text
Electron 桌面层
  renderer: SVG 棋盘 + DOM 棋子 / 动画 / 回看 / 配乐
  main + preload: 主进程棋钟 / 保存 / 白名单 IPC
          ↓ 人类走子、比赛命令
业务层
  engine: 全谱重放 / 全部合法走法 / 将帅安全 / 胜负
  expert + evaluation: 攻防关系 / 位置与协同 / 交换与对手反击
  search + live-search + plan: 有界多步对抗 / 提交复查 / 条件连续计划
  knowledge + learning: 来源定式 / 赛后验证 / 当前案例召回
  GameService: 权威状态 / 时钟 / 比分 / revision / 回合提交端口
          ↓ 回合快照 + 完整棋谱 + 逐手摘要
Pi 扩展层
  analyze_position / search_position / review_move / compare_moves
  simulate_moves / update_plan / move_piece
  工具参数校验 → TurnPort.commit → 再次业务校验
          ↕ 工具调用及结果
Agent Loop 层
  原生 Pi SDK createAgentSession + ModelRuntime
  模型 ↔ 工具循环，允许非法走法纠错，成功提交结束回合
```

| 层 | 文件 |
|---|---|
| 业务规则、专家计算 | `src/business/engine.ts`、`expert.ts` |
| 知识与案例业务 | `src/business/knowledge.ts`、`learning.ts` |
| 学习 Worker、原子库与回填 | `src/learning/` |
| 权威棋钟、比赛和回合 | `src/business/clock.ts`、`game-service.ts` |
| Pi 扩展 | `src/extensions/xiangqi.ts` |
| Agent Loop、认证与模型 | `src/agent/pi-driver.ts`、`model-selection.ts` |
| 桌面及 UI | `src/electron/`、`src/renderer/` |
| 跨层 DTO | `src/shared/types.ts` |

业务层不依赖 Pi 或 Electron，以 `AgentDriver` / `TurnPort` 注入。每次走子从完整棋谱重建棋盘、校验胜负并记录分析。模型收到完整棋谱、当前棋盘、逐手摘要、全部合法走法、专家报告与结构化旧计划；可自行试算最多 6 手，或调用有界对抗搜索。候选分数结合有限反击、同格交换与位置因素，**不是胜率或完备搜索**，不代替模型决策。

每次 Agent 尝试的搜索总预算至多 2600ms / 70000 节点，工具搜索预留最终审查的 700ms / 20000 节点；单次受棋钟余量约束（至多余时的 1/12），危险局面适当增加预算。Worker 启动 / IPC 计入墙钟预算，硬看门狗允许额外 150ms 清理余量。搜索未完成或失败明确记录为未知，不伪造安全或胜率；最终提交仍执行原来的独立交换审查。

每个机器回合使用隔离的内存 Pi 会话，仅启用七个象棋工具；不加载用户 / 项目扩展、技能、上下文文件、MCP 或编码工具。单回合最多 8 个模型回合、16 次工具调用。取消、悔棋、换模型、新比赛或超时会使旧请求失效；重复提交和过期版本均拒绝。此工具隔离不是操作系统沙箱，仍应只使用可信的本机 Pi 配置。

## 规则范围

基本走法、马腿、象眼、河界、炮架、九宫、将帅照面、应将、将死及困毙均校验。**困毙判负，不是西洋棋的逼和。** 普通三次重复和棋；重复循环中单方每步长将则该方负。连续 120 半回合无吃子且无兵卒移动和棋。

这是明确的简化竞赛规则，**不声称完整实现《中国象棋竞赛规则》的长捉、循环追捉、裁判裁定等条款**；不自动裁定所有理论例和。棋谱使用 A0–I9 起终点坐标，不是「炮二平五」式记谱。完整约定见 [RULES.md](RULES.md)。

## 自动保存

每局独立 ID，原子串行写入 Electron `userData/records/<game-id>.json`；macOS 默认：

```text
~/Library/Application Support/Chinese Chess LLM/records/
```

退出前保存最新时钟并等待排队写入（最多 3 秒）；保存失败会弹窗提示。学习库保存在同一 userData 下的 `learning/library.json`，带原子事务、重验和一代备份。未完成复盘会在下次启动重做。当前支持自动保存、手动导出、当前局回看及历史复盘列表，**暂不支持旧棋谱棋盘导入或跨启动续局**。

## 验证

```bash
# 应用目录
just check       # TypeScript、规则/业务/真实 Pi 集成测试、构建
just smoke       # 真实 Electron + Playwright 桌面验证
just learn       # 不启动 Electron，回填本地已结束棋谱（不联网）

# 仓库根目录
just chinese-chess-check
just chinese-chess-smoke
```

离线测试覆盖：初始局面 44 种合法走法、已知 perft(2)=1920、所有棋子走法和将帅安全、将死 / 困毙、普通重复 / 长将、120 半回合、完整重放、棋钟精确边界、迟到提交、取消 / 重试 / 悔棋、三局 / 五局比分。另手工核对初始局面 perft(3)=79666。

离线测试还覆盖真实双方失误回归、交换 / 牵制 / 毒卒 / 一步杀 / 预算截断、提交风险复查、案例验证 / 去重 / 镜像换色召回 / 并发持久化 / 损坏恢复 / 回填，以及全部定式路线和偏离定式的处理。新增 53 手被动败局回归：底炮配合双车转肋的多步杀、垫象 / 垫马比较、搜索 Worker 取消 / 崩溃 / 硬时限、异步提交竞争 / 棋钟超时、位置指标和计划生命周期。测试数量以 `bun test` 输出为准；不据此宣称实战胜率提高。

Pi 集成测试通过本地 OpenAI-compatible SSE 服务运行**真实 Pi SDK Agent Loop**，验证七个工具的隔离、专家分析 / 审查 / 比较 / 试算、多步搜索与计划更新、等待异步提交、非法走法与送车风险纠错、成功后终止、请求预算、取消、超过旧 90 秒阈值的长考和总棋钟耗尽后的网络中止，不消耗外部 API 额度。

Electron smoke 使用显式 `CHINESE_CHESS_SMOKE=1` 的 UI 测试替身；正常启动不使用此分支。验证吃子动画、键盘、回看 / 悔棋、黑方开局、三局两胜、五局设置、真实棋钟超时、三个窗口尺寸、本地 MP3 实际解码播放 / 切换、自动保存、来源专家报告、真实 Worker 回填 / 复盘界面 / 案例事务及 IPC 隔离。截图输出到 `artifacts/`（gitignored）。外部模型的网络与认证仍需使用你自己的账户实测。
