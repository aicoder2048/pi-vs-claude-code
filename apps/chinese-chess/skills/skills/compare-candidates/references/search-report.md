# 搜索覆盖
completedDepth：最后完整迭代；attemptedDepth：尝试深度，不可当已完成。
rootScope=all-legal：搜索所有合法根；requested-subset：仅提交的候选，不是全局最优。
bestMove/principalVariation/rootScores：有界评分与主变化，非胜率。stopped、nodes、horizonCuts、limitations 描述预算和地平线。
零深度、预算耗尽或失败都不是安全证书。单步反击和 SEE 不覆盖全部异地战术、强制应将与长期弃子；最终提交仍由业务独立审查。
