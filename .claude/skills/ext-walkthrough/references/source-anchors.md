# Pi 源码锚点（1.4.0 · vendor/pi 4a08025）

源码根：`/Users/szou/Python/Playground/LearnTopEngSkills/vendor/pi/packages/`
页面里的链接前缀（页面在 `walkthroughs/` 下）：`../../../../../vendor/pi/packages/`

这些行号是起点，不是事实。Pi 一升级就会漂移，所以写进页面之前，先 grep 一次确认符号确实在那一行；`scripts/check.py` 只能查出行号是否越界，查不出是否指错了符号。

```bash
P=/Users/szou/Python/Playground/LearnTopEngSkills/vendor/pi/packages
grep -n '<符号>' $P/agent/src/agent-loop.ts $P/coding-agent/src/core/agent-session.ts \
  $P/coding-agent/src/core/extensions/runner.ts $P/coding-agent/src/modes/interactive/interactive-mode.ts
```

## settle 外循环（agent-session.ts，路径 coding-agent/src/core/agent-session.ts）

| 符号 | 行 |
|---|---|
| `_startRun`（外循环本体） / `agent.prompt` | 1873 / 1899 |
| `_prepareRun` / `emitBeforeAgentStart` | 1926 / 1935 |
| `_handlePostAgentRun`（retry / compaction / 排队） | 1979 |
| `_runBeforeSettleBoundary`（agent_before_settle） | 2017 |
| `_emitAgentSettled` / emit agent_settled | 1078 / 1084 |
| `prompt()` / `input` 处理 | 2092 / 2117 |
| `session_start`（启动） / reload 时再发 | 3339 / 3755 |
| tool_call / tool_result 桥接 | 668 / 690 |
| `_handleAgentEvent` / `_emitExtensionEvent` | 1103 / 1303 |
| 同一事件先发扩展、再发 UI（扩展改的状态，UI 重绘时能看到） | 1143 / 1144 |
| message_end 落盘 | 1147 |
| `getContextUsage()` / 绑给 ctx | 4297 / 3513 |

## run 内循环（agent/src/agent-loop.ts）

| 符号 | 行 |
|---|---|
| `runLoop` 的 `while (true)` / 内层 while（两个都在转 turn） | 188 / 192 |
| agent_start / 首个 turn_start | 126 / 127 |
| 后续 turn_start / turn_end / agent_end | 216 / 296 / 329 |
| getFollowUpMessages | 311 |
| transformContext → convertToLlm | 400 / 404 |
| message_start / message_update（流式） | 430 / 446 |
| tool_execution_start：串行 / 并行（495 是输出被截断时的失败路径，别引它） | 553 / 608 |
| beforeToolCall / prepareToolCall 入口 | 738 / 718 |
| tool_execution_end（被拦截、出错的调用也会发） | 931 |

## 扩展层

| 符号 | 位置 |
|---|---|
| 旧包名 `@mariozechner/*` 别名表（每个包一行：pi-coding-agent 111、pi-agent-core 112、pi-tui 113，按扩展实际 import 的包引用） | `coding-agent/src/core/extensions/loader.ts:111–117` |
| jiti.import / `factory(api)` | `loader.ts:584` / `:627` |
| runner `createContext` / `get model` / `getContextUsage` | `coding-agent/src/core/extensions/runner.ts:884` / `:913` / `:949` |
| runner `emit` | `runner.ts:1096` |
| `transformContext` → `runner.emitContext` | `coding-agent/src/core/sdk.ts:431` |
| 系统提示词分段 `buildSystemPromptSections` | `coding-agent/src/core/system-prompt.ts:128` |
| 上下文估算 `estimateProjectedContextTokens` | `coding-agent/src/core/compaction/compaction.ts:227` |

## UI 层

| 符号 | 位置 |
|---|---|
| `bindCurrentSessionExtensions` | `coding-agent/src/modes/interactive/interactive-mode.ts:1973` |
| `setExtensionFooter` / `setFooter` 绑定 | `interactive-mode.ts:2524` / `:2651` |
| `handleEvent`（几乎每个事件都 requestRender） | `interactive-mode.ts:3363` |
| `Container.render` 逐个调用子组件 | `tui/src/tui.ts:409` |
| `requestRender` | `tui/src/tui.ts:1027` |
| 组件树挂载（statusContainer 在编辑器上方，与 footerContainer 是两个容器） | `interactive-mode.ts:984` |
| `setExtensionFooter` 里 `footerContainer.clear()`（所以多次 setFooter 是“最后一个赢”） | `interactive-mode.ts:2534` |
| `/reload` 前把扩展页脚复位 | `interactive-mode.ts:2464` |
| `setStatus` 写入 `footerDataProvider` | `interactive-mode.ts:2303` |
| `setWorkingVisible`（Working 指示器开关） | `interactive-mode.ts:2363` |
| `setExtensionWidget` / 同 key 先移除旧组件 | `interactive-mode.ts:2400` / `:2412` |
| `handleEvent` 收到 tool_execution_end 后 requestRender | `interactive-mode.ts:3599` / `:3605` |
| 内置页脚读扩展状态 `getExtensionStatuses` | `coding-agent/src/modes/interactive/components/footer.ts:290` |
| `setTheme` 写进全局 settings | `coding-agent/src/core/settings-manager.ts:754` |
| runner 按 `this.extensions` 顺序调 handler | `runner.ts:1100` |
