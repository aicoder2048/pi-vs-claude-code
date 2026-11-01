# TillDone Desk：崩溃后续接会话

目标：Pi 子进程崩溃后点 **Restart**，桌面端接回刚才那个会话：模型记得之前的对话，界面显示历史消息、工具调用和最新任务清单。**新会话**按钮仍然开新会话。

## 已核实的事实（Pi 1.4.0，2026-11-01 实验）

- `pi --mode rpc --session <path>` 能加载指定会话文件；只加载不写文件。
- 加载后扩展在 `session_start` 里自己从分支恢复清单（实验中收到 `setStatus` “3 tasks”），但**桌面端的 L3 状态不会自动跟上**，必须自己拉历史。
- `get_entries` 返回全部条目（含压缩前历史和废弃分支）和 `leafId`；从 `leafId` 沿 `parentId` 回溯得到当前分支，与扩展用的 `getBranch` 一致。
- `get_messages` 只含压缩后的上下文，压缩掉的 tilldone 结果会丢，所以清单不能只靠它。

## 设计决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | Restart 用 `--session <崩溃前的 sessionFile>`，不用 `--continue` | `--continue` 取“当前 cwd 最近的会话”，可能是同目录下 Pi TUI 的会话，不一定是崩溃的那个 |
| D2 | `sessionFile` 来自已有的 `get_state` 轮询，存进 L3 状态 | 不新增通道 |
| D3 | 没有 `sessionFile`，或文件不存在（崩溃发生在第一条消息落盘前），退回新会话 | 没有可续的内容；界面提示一次 |
| D4 | 历史用 `get_entries` + `leafId` 取当前分支，转换成与实时流同形的记录，交给现有 `reduce` 重放 | 一套投影逻辑；工具 / 模型调用计数和清单自然重建 |
| D5 | 续接后、历史填回前，输入框禁用 | 避免实时事件和历史交错 |
| D6 | 应用正常启动、新会话按钮：仍是新会话 | 本次只补崩溃续接；“启动时续接上次”留作以后的选项 |

## Stage 0：去掉 `--no-skills` / `--no-session`
**Goal**：会话落盘、技能可加载。
**Success Criteria**：测试与 typecheck 通过；真实 Pi 下 `get_state` 有 `sessionFile`，`get_commands` 列出技能。
**Tests**：`glue.test.ts` 启动参数断言。
**Status**：Complete（已提交）；白皮书 PDF 已重新生成。

## Stage 1：L2 按需带 `--session` 启动
**Goal**：Restart 续接，新会话不续接。
**Success Criteria**：
- 崩溃后 Restart 的启动参数含 `--session <path>`；新会话按钮的不含。
- `sessionFile` 缺失或文件不存在时，Restart 退回新会话并给出提示。
**Tests**（`glue.test.ts`，fake-pi 的 `get_state` 返回可配置的 `sessionFile`）：
- crash → restart → 第二次 launch 带 `--session`。
- newSession → launch 不带 `--session`。
- 文件不存在 → 不带 `--session`，出现提示。
**Status**：Complete（已提交）。`planIntent` 的 `restart` 改为 `"resume" | "fresh"`；`sessionFile` 进 L3 状态；`Desk.start(session?)`；fake-pi 支持 `FAKE_PI_SESSION` 与 `crash` 消息；smoke 断言改为 Restart 后有一条“没有找到上次会话”的提示（fake 不报告会话文件）。

## Stage 2：L3 纯函数：历史 → 记录
**Goal**：`branchOf(entries, leafId)` 与 `historyRecords(branch)`，输出与实时 RPC 同形的记录序列（`turn_start`、`message_start/end`、`tool_execution_start/end`、nudge），经 `reduce` 得到续接后的状态。
**Success Criteria**：同一段对话，“实时流”与“历史重放”得到相同的 messages、tools、list、toolCalls、modelCalls。
**Tests**（`domain.test.ts`）：
- 废弃分支上的条目不出现。
- 每条 assistant 消息计 1 次模型调用；非 tilldone 工具按当时进行中的任务计数。
- 最后一个有效 tilldone `details` 决定清单；格式不对的跳过。
- 压缩摘要显示为一条提示；未知 role 忽略；system 消息不显示。
- 带图片的用户消息保留图片计数。
**Status**：Not Started

## Stage 3：接线与界面
**Goal**：续接启动后请求一次 `get_entries`，用 `desk_history` 记录替换时间线；完成前输入框禁用；时间线开头显示“已续接上次会话”。
**Success Criteria**：fake-pi 续接场景下，界面显示历史消息、工具卡片和清单；`get_entries` 失败时保持空视图、显示错误、输入可用。
**Tests**：`glue.test.ts` 续接场景；`appearance` 中英文案；smoke 测试覆盖 crash → Restart → 历史可见。
**Status**：Not Started

## Stage 4：真实 Pi 验证与文档
**Goal**：真实环境走通，文档同步。
**Success Criteria**：
- 手工：发一条消息并建清单 → 杀掉 Pi 子进程 → Restart → 历史与清单回到界面，模型能接着上文回答。
- README、白皮书（R5 改为已解决，相关章节同步）、讨论稿 §5.1 更新；重新生成两份 PDF。
**Tests**：`bun test`、`bun run typecheck`、`bun run test:smoke` 全过。
**Status**：Not Started
