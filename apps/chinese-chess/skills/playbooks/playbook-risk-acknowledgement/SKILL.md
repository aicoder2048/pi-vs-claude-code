---
name: playbook-risk-acknowledgement
description: 收到 MoveRiskError 且考虑有依据弃子或不可避免败势时按需读取，不参与默认路由。
disable-model-invocation: true
---
# 风险说明
风险拒绝尚未落子，先比较替代候选。只有确有具体补偿或不可避免败势才提交 riskAcknowledgement（12–400 字）；说明具体路线、风险和未知覆盖，不能用“争取主动”等套话习惯性绕过。
可用 simulate_moves 检验指定变化，但它不证明对方必须配合；用 search_position 比较最强防御。
reason 是简短公开理由，不写内部思维链。说明与完整复查结果随成功落子保存。
局限：这是显式接受启发式风险，不是补偿有效证明，不能绕过非法、过期、重复或超时拒绝。
