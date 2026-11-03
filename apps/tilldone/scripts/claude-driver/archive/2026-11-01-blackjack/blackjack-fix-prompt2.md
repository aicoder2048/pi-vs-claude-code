/skill:poteto-mode 修复当前工作目录 /Users/szou/Python/Playground/DoorBird/Apps/blackjack 里的一个真实模型下才出现的 bug。

## 现象
用真实 pi + openai-codex/gpt-6.1-sol 打一局，AI 第一步下注就失败：`Pi settled without a valid commit`。模型回复“当前未提供 observe_table、evaluate_hand 和 commit_action 工具”。

## 已确认的根因
`src/agent/config.ts` 的 `piArgs` 里传了 `--tools read`。在真实 pi 1.4.0 里，`--tools` 白名单会压过扩展在 `session_start` 里调用的 `pi.setActiveTools(['read', ...tools])`，所以模型手上只有 `read`。
已在探针里验证：把参数改成 `--tools read,observe_table,evaluate_hand,commit_action` 后，真实模型完整走完 observe_table → read skills → evaluate_hand → commit_action（bet 10）→ settled。

## 要做的事
1. 修 `piArgs`：`--tools` 必须包含 read 和扩展注册的全部领域工具。工具名列表要有单一来源（例如从扩展的 L3/共享纯代码里导出一个常量，宿主和扩展都用它），不要在两处手写字符串。
2. 更新所有断言 piArgs 内容的测试。
3. 加一个回归测试保证 `--tools` 列表和扩展实际注册的工具名一致（用假 pi 即可，测试里不调用真实模型）。
4. 在 `scripts/` 里加（或补全已有的 `probe-pi.ts`）一个**手动**运行的真实 pi 检查脚本，并在 package.json 加 `test:real-pi` 脚本：用宿主的 piArgs 启动真实 pi，确认模型可用工具里有 observe_table / evaluate_hand / commit_action（例如通过 get_commands 或一次很短的 prompt）。这个脚本不进 `bun test`，README 里说明它会消耗 Codex 订阅额度、只能用 openai-codex/* 模型。
5. README 里补一句 `--tools` 白名单会覆盖 setActiveTools 的说明。

## 约束
- 不要用 Pi SDK；不要用任何 anthropic/* 模型；不要 git push；不要修改本目录以外的文件。
- 完成标准：bun run typecheck、bun test、bun run build、bun run test:smoke 全部通过。汇报改了哪些文件和测试结果。

## 续跑说明
上一次会话在任务 #4 中途被中断（桌面窗口意外关闭）。已完成：阅读技能、确认白名单机制、统一工具名（src/business/agent-tools.ts）、加注册一致性回归测试；已新增 scripts/probe-real-pi.ts、tests/real-pi.test.ts、.pi/tool-visibility-probe.ts，并在 package.json 加了 test:real-pi。
请先审查这些现有改动（不要假设它们正确），补完 #4（README 说明等），清理不需要留下的临时探针文件（比如 .pi/tool-visibility-probe.ts 若只是调试用），确认 tests/real-pi.test.ts 不会在 bun test 里调用真实模型，然后跑完全部验收。
