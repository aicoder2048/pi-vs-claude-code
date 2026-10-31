---
name: plan-protocol
description: 每回合候选比较后、落子前复核或更新公开跨回合计划时使用。
---
# 计划协议
调用 update_plan：没有计划或 invalidated 时 revise；active/needs-review 仍成立才 continue，并用 reason 解释对方上一手是否改变威胁；不适用则 abandon 或 revise。
revise 提供 objective/problem/opponentThreat/1–3 项有条件 nextSteps/abandonWhen。只写公开目标与可验证条件，不写内部思维链。
被将军必须先应将，旧计划必须 revise。对手吃子、8 半回合过期或终局会使计划失效。悔棋、换模型、新局清空。暂存只随成功落子保存，错误与取消不污染旧计划，不自动执行未来坐标。
局限：计划只是意图，不覆盖规则、威胁和最终审查。
