# L3 v3：己方强杀发现与提交前漏胜反馈

## 实战问题

`tests/fixtures/missed-white-win-g10.json` 固定白棋第 14 手前的真实局面：白 G10 迫黑 G8，再白 J7 形成 F11/K6 两个成五点。G10 不是立即成五，却有强制胜法。实际 H6 防守分更高，且 H6/G10 都通过了“未发现对手连续冲四反杀”的检查；该负结果无法比较己方进攻质量。后来黑棋超时不改变这个决策时刻，也不能将 H6 标为正确。

v3 在原有对手反证之外补上主动搜索和漏胜反馈，不引入第二个棋手、真实棋盘自动代下或额外模型。

## 共享证明内核

`src/business/forcing.ts`：

- `findOwnForcingWin(position, options)` 从当前行棋方开始，寻找一条己方连续冲四胜法。
- `checkForcingSequences(position, candidate, options)` 先通过权威 `play` 落候选，再为对手调用同一内核，维持 v2 接口与语义。
- 搜索只操作棋盘副本。从全部五格窗口生成造四点，不依赖启发式 top-N。
- 自己能立即成五时先结束；否则检查对手立即胜点。每次造四后再扫描对手是否能抢先成五，避免把无法执行的进攻当胜法。
- 无反杀且只有一个防点时，其余应手下一手均输，所以沿唯一强制应手继续；有两个不同成五点且无反杀时返回强制终点。
- 返回任意已证明胜法，不承诺最短、唯一或全局最优。同一起手可能存在不同有效后续，测试验证证明有效性，不硬编码搜索必须输出某一条变化。

己方结果 `OwnForcingWin`：

| status | 含义 |
|---|---|
| `found-forced-win` | 有 `winningCandidate` 和 `proof`（attacker/交替 line/terminal/winningPoints） |
| `not-found-within-budget` | 指定连续冲四深度内未找到，不代表没有胜法 |
| `incomplete` | 节点、时间、取消或棋钟不足，不得冒充检查完成 |

`scope=own-continuous-four-only`，与对手接口的 `opponent-continuous-four-only` 明确区分。默认三次造威胁延伸、6000 节点、200ms；工具深度 1..4、节点至多 6000、时间至多 200ms；业务硬上限 20000/500。单调时钟、初始/周期让出事件循环、取消和棋钟约束沿用 v2。范围不含连续活三、完整博弈树或战略最优。

## 自动发现和工具

普通中盘（至少八手，无当前即时胜负，距丢失当前时段大于 15 秒）：

1. `evaluate_threats` / `analyze_position` 第一次观察自动搜索并附带 `ownForcingWin`，不要求模型先想到 G10 或额外调用工具。
2. 同回合缓存自动结果；重复观察不重算。显式零预算/浅负结果不能抑制一次默认自动搜索，也不能抹去已有正证明。
3. `find_forcing_win(revision, optional budgets)` 可显式搜索，返回只读证据；不替代 observe。
4. `place_stone` 也有提交前搜索兜底，不依赖提示词自觉。

工具增至八个，8 次模型请求/16 次工具调用上限不变。自动搜索不额外消耗一次工具调用，但计算与反馈等待照常计时。

## 漏胜反馈门禁

```text
observe → 自动发现己方强杀并返回证明
下一次模型请求：
  选择证明起手 → 一步合法性/棋钟验证 → 提交
  选择其他起手 → accepted:false + needsReview + missed-forced-win
下一次模型请求：
  改选证明起手，或明确 acknowledgeMissedWin:true 并完成其他候选反证
```

- 同批预排“观察/搜索 + 提交”不算已读证明，即使预先设置确认参数也先返回 `unread-forced-win` / `missed-forced-win`，没有落子。
- 选中已返回先前请求的证明起手无需重复查对手反杀；该证明已覆盖防守者的抢先成五。
- 选择其他合法落点需单独 `acknowledgeMissedWin:true`；`acknowledgeRisk:true` 只确认旧对手反证风险，不能绕过漏胜反馈。确认不等于该落点正确，也不证明它一定输。
- 后续较浅负结果、未完成结果不抹去同 revision 已知正证明；保留所有检查。
- 开局、当前立即胜负或紧迫棋钟不强迫新增等待。显式紧迫搜索返回 `incomplete/clock-budget`；新压力下允许及时提交，真实截止仍由 GameService 判定。
- 只有 `accepted:true` 结束同批工具与后续请求；所有拒绝反馈都没有改动真棋盘。

## 持久化与知识

知识版本 `gomoku-knowledge/v3`，新增按 ID 读取的 `find-forcing-win` 技能，并更新入口、中盘、战术/证据原则和验证技能。仍不发现用户目录技能或赋予文件工具。

保持 `five-llm/v1` 记录与 `candidate-review/v1`，新增可选字段：

- `ownWinChecks`：id、revision、来源 observe/explicit-tool/pre-commit、结果/预算/证明、返回模型请求序号、提交前是否已返回先前请求。
- `ownWinReview`：reviewed / skipped-time-pressure / not-required-immediate / not-checked；reviewed 仅表示反馈跨过请求边界，不证明模型理解，也不将未完成状态改成完整。
- `declinedProvenWin`：是否在读过正证明后显式选择其他候选。
- `coverage=own-forcing-proof`：仅最终选择已读证明起手时使用；其他候选不能冒领这条证明。

旧 v1/v2 手记仍可读取。GameService 深拷贝、撤销/新局清理和保存不变；未成功提交的尝试不伪造成落子手记。

## 验证与边界

```bash
bun test tests/missed-win-case.test.ts tests/own-forcing.test.ts
bun test tests/pi-integration.test.ts tests/knowledge.test.ts
bun run check
bun run test:smoke
```

覆盖 G10 自动发现、原短胜法及搜索返回的有效变化；关键节点穷举全部合法防守；八种旋转/镜像及黑方进攻；即时胜负/反杀、浅层边界、预算、取消、终局；真正 Pi 调度的自动观察、漏胜拒绝/改选、显式确认、同批不能冒充已读、浅负不抹正证明、零预算不能绕过自动搜索、紧迫跳过、棋钟继续扣时及迟到判负、导出证明深拷贝隔离。

本地 SSE 测试验证真实 Pi Harness 的证据传递与门禁，不验证外部真实模型棋力。系统仍可能因预算、未覆盖的杀法或模型明确放弃已知胜法而漏胜；这不是全局必胜求解器。
