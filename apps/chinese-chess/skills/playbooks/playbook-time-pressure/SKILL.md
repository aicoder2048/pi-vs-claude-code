---
name: playbook-time-pressure
description: 剩余棋钟低于宿主预算阈值时使用，优先已有证据并及时完成合法落子。
disable-model-invocation: true
---
# 时间压力
直接读取已有 signals、回合前搜索和当前计划，减少额外技能读取。仅比较 1–2 个可行候选，优先处理强制威胁；需要报告才 analyze_position。
未完成搜索不是安全。简短复核计划并尽快 move_piece，网络、思考和计算均扣时，不要尝试耗完工具预算。
局限：不能为抢时间绕过合法性、revision 或独立风险审查；不另设单步时限。
