/skill:poteto-mode 在当前工作目录 /Users/szou/Python/Playground/DoorBird/Apps/blackjack 把单次 AI 决策的默认技术超时从 60 秒改成 180 秒。

## 背景（真实运行观测）
用真实 pi + openai-codex/gpt-6.1-sol 打了 14 局：每个决策实际耗时 15–50 秒，偶尔更长；默认 60 秒下有 2 次 `Blackjack decision deadline exceeded`（分牌后第二手、普通出牌各一次），界面只能点“重试 AI”。设 BLACKJACK_TIMEOUT_MS=180000 后再跑 4 局（含分牌+加倍的 4 决策局）无超时。

## 要做的事
1. `src/agent/config.ts`：`BLACKJACK_TIMEOUT_MS` 默认值 60000 → 180000（上限 600000 不变）。
2. 同步所有写着 60 秒 / 60000 的地方：README.md（第 115 行附近说明、第 123 行配置表）、skills/blackjack-coach/SKILL.md（预算说明）、docs/design-review.md（把“需要真实运行观测”那条更新为上面的观测结论）。用 grep 确认没有遗漏。
3. 更新断言旧值的测试（tests/skills.test.ts 等）。测试里显式设置的短超时（smoke、service、rpc 测试用的 2000/2500/20000）保持不变。
4. 不要改其它预算（8 个模型 turn、16 次工具调用、RPC 单命令 10 秒）。

## 约束
- 不要用 Pi SDK；不要用任何 anthropic/* 模型；不要 git push；不要修改本目录以外的文件；不需要跑真实模型。
- 完成标准：bun run typecheck、bun test、bun run build、bun run test:smoke 全部通过。汇报改了哪些文件和测试结果。
