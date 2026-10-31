---
name: verify-board
description: 在落子提交前验证候选与对手一手反击；成功落子后不可再调用验证工具。
---

# 提交前验证

触发：选出候选后、place_stone 之前。

1. 已用 analyze_position 或 evaluate_threats 获取当前 revision 的事实。
2. 可调用 validate_move(x,y,revision)，检查合法性、winner、opponentImmediateWinsAfter 与 warnings；或依靠 place_stone 自动执行同样检查以减少调用。
3. 若放弃本手直接胜、或留下对手一步成五，应重新审视选择；若局面已不可防，承认扫描局限与困难，不虚构安全证明。警告不是禁手，仍允许合法提交。
4. 普通中盘用 check_forcing_sequences 对最终候选做连续冲四反证，必要时读取 check-forcing-sequences 技能。读到结果后的下一次请求才提交；有时间时另用 simulate_moves 检查其他强应手，无时间时保留跳过原因。不要只验证对手配合的一条线路，not-found-within-budget 或 incomplete 都不保证安全。
5. 调用 place_stone。accepted:false/needsReview 表示还未落子，必须先处理提交前反馈；若坚持有败势或检查未完成的候选，用 acknowledgeRisk:true 明确确认。只有 accepted:true 才完成原子提交并立即终止回合，不能要求提交后再 analyze_position。

证据：提交记录保存候选检查和实际工具进度；不保存私有推理。scope=one-ply-only，无警告不代表必胜、最优或深层安全。
