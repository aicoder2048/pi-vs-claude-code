---
name: evaluate-threats
description: 获取和解读自由五子棋威胁信号；候选排名与即时成五事实冲突时优先事实。
---

# 威胁评估

触发：每回合 observe，或试算后需要辨别战术事实与启发式。

- 调用 evaluate_threats，读取 revision、signals.facts 和 signals.priority；analyze_position 兼容完整棋盘与旧分析格式。
- immediateWins 是当前行棋方下一子即可成五的所有空点；opponentImmediateWins 是对手若现在走即可成五的点，不是完整威胁树。
- 自身立即胜优先。自身无立即胜且对手有两个不同成五点时，一子不能全部占据；unavoidableLossInOne 只陈述这一层事实。
- candidates 只保留局部最高的十二点；四方向五格窗口、断点、双三/双四标签用于排序，不是严格活三识别或强制胜证明。
- 普通中盘观察结果附带 ownForcingWin（缓存于当前 revision/回合），读取 result.status、winningCandidate、proof.line 和 winningPoints。find_forcing_win 可显式重新搜索；found-forced-win 是己方连续冲四证明，不是启发式排序。未找到或未完成不代表没有胜法。
- 需要更深比较时调用 simulate_moves：1–6 手，双方交替，在副本上计算。单条合作变化不能证明对手必走。

证据：全盘即时扫描与试算结果。停止条件：已找到直接胜点，或预算不足时进入验证和提交。不将 heuristic score 转为概率。
