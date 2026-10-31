---
name: principle-single-commit
description: 最终落子或收到提交错误时使用；本回合只允许一次成功的权威提交。
---
# 单次提交
步骤：继续对弈用 move_piece；主动放弃用 resign_game。两者都用当前 revision 和公开中文理由，落子另需业务坐标；失败先修正，任一成功立即结束，不能又认输又落子。
证据：accepted 和业务 TurnNote / resignation，不以自然语言宣称已落子或已认输。
局限：风险说明只接受启发式风险，不放宽硬规则；未来计划不会自动执行。
