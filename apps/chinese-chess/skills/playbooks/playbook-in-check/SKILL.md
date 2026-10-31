---
name: playbook-in-check
description: 当前被将军时由宿主优先使用，比较吃将军子、垫子与移将的合法应手。
disable-model-invocation: true
---
# 被将军
全部合法走法已经只剩应将；需要穷举时用 analyze_position，不考虑其他走法。
比较合法吃掉将军子、垫子、移将，注意回吃、照面、垫子后的失守和困毙；这不是机械优先级。用 review_move 查 losingReply 和 estimatedNet，用搜索检查连续将军。
若全都亏子，比较已覆盖的较小损失；未覆盖是未知，不虚构补偿。旧计划必须 revise，不可 continue。
局限：SEE 不覆盖完整应将组合；completedDepth 才是完整多步证据。
