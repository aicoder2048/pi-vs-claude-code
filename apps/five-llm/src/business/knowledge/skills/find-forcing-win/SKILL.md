---
name: find-forcing-win
description: 在当前局面寻找己方连续冲四强杀，读取强制线路并在提交前避免漏胜，不用防守安全检查代替进攻比较。
---

# 己方强杀发现

## 触发与执行

1. 先用 evaluate_threats 或 analyze_position 获取事实。普通中盘、没有立即胜负且时间不紧迫时，观察工具自动搜索并附带 ownForcingWin；不是只扫描启发式前十二个候选。
2. 需要重新搜索时调用 find_forcing_win(revision)，可选 maxAttackMoves（1..4）、maxNodes（0..6000）、maxMs（0..200）。它本身不替代 observe，也不落子。
3. found-forced-win：读取 result.winningCandidate、proof.line、proof.winningPoints。搜索考虑对手抢先成五、唯一强制应手以及多个成五点无法兼顾的终点；优先考虑已证明起手，再解释公开战略理由。
4. not-found-within-budget 只表示指定连续冲四深度内未找到；incomplete 表示节点、时间、取消或棋钟不足。未找到不代表没有胜法，两者都不覆盖连续活三或全局最优。
5. 必须在下一次模型请求读到证明后再提交，不能用同批预排落子冒充已读。place_stone 返回 accepted:false/needsReview 和 missed-forced-win 时还没有落子。选择已证明起手可以直接提交，无需重复对手反证。
6. 若读过证明后仍坚持其他合法落点，显式 acknowledgeMissedWin:true，并完成该候选的对手反证检查；acknowledgeRisk:true 仅确认反证风险，不能代替漏胜确认。工具不自动替换落点，只有 accepted:true 才终止回合。

## G10 实战回归

白第 14 手 G10 并不立即成五，但迫黑第 15 手 G8，再白第 16 手 J7 得到 F11/K6 两个成五点，黑无法同时防住。实际 H6 通过对手反证不等于进攻质量优于 G10；后续黑棋超时也不能说明 H6 是正确选择。

默认最多三次造威胁、6000 节点、200ms。证据绑定 revision、来源、预算和返回请求序号；较浅负结果不能抹去已知正证明。时间紧迫时跳过额外搜索/反馈等待，显式搜索返回 incomplete/clock-budget；不改变权威棋钟与合法性。
