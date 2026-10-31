---
name: read-expert-report
description: 阅读 signals 或全量专家报告、需要区分合法攻击与几何保护时使用。
---
# 读专家报告
先看 inCheck、lastMove、priorities、受攻己方大子，再读 phase、material、formation。safety 的 legalAttackers 才是当前合法吃子；geometricDefenders 只是几何保护，pinnedToKing 子不能随意离位。马腿和炮架随走子改变。
候选只是预算内短名单，不是全部合法走法；完整合法走法或缺失字段按需从 analyze_position 获取；当前 signals 与已经读取的全量报告无需在同一 revision 反复获取。position 的 development/mobility/coordination/kingPressure/constraints/wastedTempo 是小权重启发式，不是安全或胜率证明。
按 principle.id 查 references/principles.md；字段见 references/fields.md。不能为读报告耗尽棋钟。
