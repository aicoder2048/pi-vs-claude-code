# 讨论记录：L4 走向 Web / 桌面，以及“循环固定”和“一切皆插件”的取舍

- **日期**：2026-10-28
- **背景**：Sean 想重构 12-b 走读时提了一批四层架构的问题。教学部分放进了阅读指南 `walkthroughs/guide-four-layers.html`。本文只收**还没有代码的设计方向和观点**，供以后写 spec 时参考。
- **状态**：讨论稿。第 1 节是查证过的事实，标了来源；第 2–4 节是提案和判断，没有实现过。

---

## 1. 已查证的事实

| 事实 | 来源 |
|---|---|
| Pi 1.4.0 的 L4 是终端界面（pi-tui）；`vendor/pi/packages` 下没有 web UI 包 | 本地源码目录 |
| Pi 可以由别的程序驱动，有四种方式：print、JSON 事件流、RPC（独立进程，stdin/stdout）、TypeScript SDK（`createAgentSession`，嵌进应用） | Pi 文档 `index.md`、`rpc.md`、`sdk.md` |
| RPC 模式下扩展 UI 会降级。`select`/`confirm`/`input`/`editor` 变成请求/应答子协议；`notify`/`setStatus`/`setWidget`/`setTitle` 变成单向消息；`custom()` 返回 undefined；`setFooter`/`setHeader` 等不生效 | Pi 文档 `rpc-extension-ui.md` |
| 扩展里可以起本地服务。本仓库 `scripts/coms-net-server.ts` 用 `Bun.serve` 起中转服务，扩展通过 HTTP + SSE 和它通信 | 本仓库，走读 18 |
| Claude 桌面版是 Electron 应用。Claude Code 团队的说法是：这样能和网页版共用代码，保证两边观感一致 | Hacker News 上 Claude Code 团队成员的回复（news.ycombinator.com/item?id=47104973） |
| DeepSeek Harness 建在 Cordis 插件内核上。模型适配、工具、会话、沙箱、存储、调度、agent loop、UI 都是插件，可以在配置里替换；插件之间通过 `ctx.tools`、`ctx.llm`、`ctx.sessions` 这类服务键协作；`dsh web` 启动网页界面 | DataCamp《What Is DeepSeek Harness?》、DeepInfra 评测、github.com/deepseek-ai/deepseek-harness |

**没查证到的**：DeepSeek Harness 的 web 界面到底是“本地服务 + 浏览器”还是别的形态，公开资料只写了 `dsh web`。推断是本地服务加浏览器，没有核实。

---

## 2. L4 想画图片、动画、富表格，有哪几条路

终端画不了图片、three.js 动画和交互式表格。可选的方向，从改动小到改动大：

| 方向 | 做法 | 优点 | 代价 |
|---|---|---|---|
| A. TUI 不变，扩展内起本地 web 服务 | 扩展在 `session_start` 里 `Bun.serve` 起一个本地页面，通过 SSE 推状态；TUI 只显示一个链接或摘要 | 不碰 Pi 宿主；照搬 coms-net 的套路；TUI 和网页同时可用 | 两个界面要同步；要管端口、生命周期（`session_shutdown` 关服务）、只绑 127.0.0.1 |
| B. RPC / SDK 宿主 + Web 客户端 | 一个本地服务进程用 SDK 跑 Pi（或用 RPC 驱动 Pi 子进程），把会话事件和扩展 UI 请求转成 WebSocket/SSE 推给浏览器；服务和网页同源打包成一个可执行程序 | 界面完全自由；同一套前端可以本地跑、也可以部署 | 依赖 `setFooter`/`custom` 的 L4 代码要重写；确认框等走协议 |
| C. 在 B 的基础上套 Electron（或 Tauri）桌面壳 | 桌面壳里跑 B 的服务和前端 | 桌面体验（托盘、通知、文件拖放）；和 Claude 桌面版同一路线 | 打包、签名、自动更新的工程量 |

**判断**：先做 A 验证需求，确定要长期投入再走 B，C 是 B 的外壳。A 到 B 之间能平滑过渡的前提，是 L3 已经和 L4 分开：L3 的选择器（例如 tilldone 的 `countByStatus`、`current`）终端和网页都能用，只需要再写一套 Web 的 L4。

## 3. 如果做一个“视觉更丰富”的自定义 Pi Harness 桌面版，L4 要怎么安排（提案）

1. **L4 拆成“视图模型”和“渲染器”两半。** 视图模型是纯函数：L3 的状态进，要显示的数据出。它可以放在 L3，也可以放在 L4 的共享部分。渲染器分两份，TUI 一份（pi-tui 组件），Web 一份（React/three.js…）。tilldone 的 `paint` 现在把这两件事做在了一起，要先拆开。
2. **扩展到前端的数据只走一条事件流。** 扩展不直接操作网页，而是发结构化事件，宿主统一推给前端。可以复用 Pi 自己的会话事件和 RPC 的 extension UI 协议，自定义的部分用 `pi.events` 或 `sendMessage` 的 `customType` 区分。
3. **对话框统一走 Pi 的请求/应答协议。** `confirm`/`select` 在 RPC 下本来就是这个协议，Web 端只要实现应答，L2 的代码不用改。
4. **界面与上下文分离的原则不变。** 网页上的图表、完整数据不进上下文；冲突时以界面为准（这是四层讨论记录里定下的原则）。
5. **安全**：本地服务只绑 127.0.0.1，带随机 token；不把会话内容放进 URL 参数。

## 4. “循环固定”还是“一切皆插件”

| | Pi（循环固定，插点开放） | DeepSeek Harness（一切皆插件） |
|---|---|---|
| 想改循环本身 | 做不到，只能 fork | 换一个 loop 插件 |
| 扩展作者要理解的东西 | 一套固定的双循环和插点 | 插件之间的服务契约，以及“当前装了哪个 loop” |
| 行为可预测性 | 高：所有扩展面对同一个循环 | 取决于装配。有评论指出，热插拔的循环不等于可靠的生产工作流（waylandz.com 的文章） |
| 适合 | 在一个稳定内核上叠业务（本仓库的做法） | 研究和比较不同的 agent loop、调度策略 |

**判断**：这套走读的目标是“在 Pi 上做领域 harness”，所以把 L1 当作动不了是合理的前提。真的需要换循环时，例如做 durable、可恢复的长任务，先看 Pi 自己的 `packages/durable`（“Durable conversation, task, and document runtime for Pi”），再考虑换内核。

## 5. 未决问题

1. 方向 A 的本地页面，是每个扩展各起一个服务，还是做成一个共享的“UI 宿主扩展”，其他扩展通过 `pi.events` 往里推？
2. 视图模型放在 L3 还是 L4 的共享部分？它不含业务规则，但会被两个渲染器共用。
3. 要不要先把 tilldone 的 `paint` 拆成视图模型加 TUI 渲染器，作为方向 A 的样板？
