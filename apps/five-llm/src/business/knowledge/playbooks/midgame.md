# 中盘剧本

触发：无即时成五威胁、非前八手、时间不紧迫。

1. **observe**：获取当前攻防事实，区分全盘即时扫描和局部候选排名。evaluate_threats / analyze_position 自动附带 ownForcingWin，搜索己方连续冲四胜法，不只检查自己会不会输。
2. **compare**：先读 ownForcingWin；found-forced-win 时核对 winningCandidate、proof.line 和 winningPoints，优先考虑已证明胜法，需要时调用 find_forcing_win 或读取 find-forcing-win 技能。选中已证明起手且读过结果后，无须再重复做对手反证。否则比较两三个候选。声称“下一步形成活四/进攻”前，先问对手会允许这个自由回合吗？对最终候选调用 check_forcing_sequences，优先检查对手冲四造成的连续被迫应手，而不只试算对手配合的分支。需要时 read_knowledge('check-forcing-sequences')，再用 simulate_moves 探索其他变化。
3. **verify**：读取连续先手检查的状态、强制线路、预算与局限；found-forced-loss 应重新比较其他候选，not-found-within-budget 不代表安全，incomplete 不得冒充已完成。validate_move 的 one-ply-only 验证仍用于即时胜负，不能代替深一层反证。
4. **commit**：在下一次模型请求读到反馈后，使用当前 revision 提交；不把检查和预先安排的落子放在同批当作已审查。若 place_stone 返回 accepted:false/needsReview，尚未落子，读反馈后重选；若坚持有败势或检查未完成的候选，显式 acknowledgeRisk:true。存在已证明胜法却坚持其他落点时，需在先前请求读到证明后另设 acknowledgeMissedWin:true；acknowledgeRisk:true 不能绕过漏胜反馈。只有 accepted:true 才结束回合。时间转为紧迫时缩短探索，不延误即时胜负或截止时间。

证据：revision/候选绑定的 simulationId、forcing 检查 ID、分支、状态、预算及反馈请求边界。局限：六手单线不覆盖全部对手应手；连续冲四搜索不覆盖其他杀法；未找到不代表没有胜法，分数不是胜率。G10 实战例：白 G10 迫黑 G8，再白 J7 形成 F11/K6 两个成五点；不能只因 H6 防守分高就漏掉该胜法。
