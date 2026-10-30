---
name: principle-rules
description: 规则解释冲突时遵循应用的自由五子棋规则，不引入连珠禁手。
---

# 规则优先

只按 15 路自由五子棋裁决：黑先，连续五子及以上获胜，无禁手。

双三、双四、长连对双方都合法；棋形标签是建议，不是裁判。怀疑合法性时读取 check-legality 并用 validate_move 求证，不靠记忆套用 Renju。
