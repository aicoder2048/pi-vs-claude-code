# 归档：2026-11-01 Blackjack 实战

`desk-run.ts` 就是从这一批脚本里泛化出来的。这里的文件**原样保存，不再维护**：路径写死成当时的位置（`/Users/szou/Python/Playground/DoorBird/Apps/...` 和那次会话的 scratchpad），不在 typecheck 范围内，直接运行多半会失败。留着是为了看当时怎么做的，以及 prompt 的真实写法。

那次让边牧在 `DoorBird/Apps/blackjack` 从零建了一个四层架构的 21 点 Electron 游戏（AI 同桌通过 Pi 工具调用出牌），又派了两轮修复。

## 驱动桌面（已被 `desk-run.ts` 取代）

| 文件 | 做什么 |
| --- | --- |
| `desk-blackjack-run.ts` | 第一版驱动：发 `blackjack-prompt.md`，只处理确认框 |
| `desk-blackjack-fix-run.ts` | 同上，prompt 和日志文件名可从命令行传 |
| `desk-pstack-e2e.ts` | 在桌面里并行跑两个 arena 子 agent，验证 pstack 接通；现在用 `../../prompts/pstack-arena-check.md` 加 `desk-run.ts` |

## 发给边牧的 prompt（`../../prompts/TEMPLATE.md` 由此整理）

| 文件 | 任务 |
| --- | --- |
| `blackjack-prompt.md` | 从零构建：参考实现、游戏规则、Pi 接入方式、四层分工、L3 设计需求、约束、完成标准 |
| `blackjack-fix-prompt.md` | 修 `--tools` 白名单压过 `setActiveTools` 导致模型没有领域工具的 bug |
| `blackjack-fix-prompt2.md` | 同一个修复的续跑版：上次在第 4 步被中断，先审查已有改动再继续 |
| `blackjack-timeout-prompt.md` | 把 AI 决策超时从 60 秒改成 180 秒，附真实运行观测 |

## 验证生成出来的游戏（和桌面无关，属于 Blackjack 项目）

| 文件 | 做什么 |
| --- | --- |
| `bj-probe.ts` | 直接起真实 pi，看模型在一个决策里调了哪些工具 |
| `bj-scenarios.ts` | 无界面：指定牌面跑 6 个基本策略场景（分牌、加倍、停牌） |
| `bj-ui-scenarios.ts` | 有界面：同样的牌面在游戏窗口里跑 |
| `blackjack-real-hand.ts` | 在游戏窗口里用真实模型打一手 |
| `pw-mark.ts` | 调试 Playwright 启动 Electron 时 `NODE_OPTIONS` 是否传进去的小探针 |
