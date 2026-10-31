---
name: compare-candidates
description: 比较合法候选、检查对方最强反击或解读搜索覆盖时使用。
---
# 比较候选
提出 2–3 个不同意图的合法候选：直接防守、主动解围、改善或反击。先检查同一 revision 的已有候选与自动搜索；已有结果覆盖实际候选且证据足够时可复用，不必为走流程重算。

缺多个候选的反击证据时，一次 compare_moves（1–6 个，公平预算）比对，不连续逐个调用 review_move；只有一个新候选才优先 review_move。核对 losingReply、estimatedNet、line 与 coverage；不只查报告短名单。覆盖不足、位置变化或出现新风险时仍应补算，不把“减少往返”当成省略审查。
已有自动搜索的 completedDepth/rootScope/候选变化可先使用；需要更深或新增候选证据再 search_position。省略 moves 搜全部合法根，传 moves 只搜 1–6 个候选；先看对方最佳防御和反将，再比较出子。simulate_moves 只验证指定 1–6 手，不证明对方必须如此应对，不得当强制变化。
吃兵前算是否丢马炮，不能用将军和位置分抵消送车。局限与字段见 references/search-report.md。
