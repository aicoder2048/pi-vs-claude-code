# 期权交易助理

这是基于 Electron 和外部 Pi RPC 的美股期权建议桌面。当前可以加载 Massive 日线与期权链，并通过只读工具查询单个合约。应用只给建议，不下单，不连接券商，也不访问真实账户。

Stage 0 和 Stage 1 已完成并通过验收。界面默认中文。Stage 2 至 Stage 7 尚未实现。详见[实施计划](IMPLEMENTATION_PLAN.md)。

## 启动桌面

需要 Bun、just、可运行的 Electron，以及 PATH 中的 `pi` CLI。版本与依赖见 [package.json](package.json)。本应用不安装或嵌入 Pi SDK。

在仓库根目录运行：

```bash
just option-trading-agent-install
just option-trading-agent
```

也可以在本目录运行：

```bash
bun install
bun run start
```

窗口标题为“期权交易助理”，界面默认使用简体中文。看到“Pi 已就绪”后可以加载行情或发送问题。启动只做资源和模型元数据检查，不自动发问、不自动加载行情。

### 使用行情表格和对话

1. 填写“股票代码”和“日线天数”。日线天数为 1 至 500，默认 20。
2. 按需填写请求用的“到期日”和行权价范围。最低与最高行权价必须同时填写或同时留空。
3. 点击“加载”。此操作经 Pi 扩展命令读取日线与期权链，不调用模型。
4. 使用“显示到期日”和“期权类型”筛选已返回的期权链。这两项只做本地筛选，不重新取数。表格每次显示一个到期日，初始选择请求的到期日，未指定时选择返回结果中最近的到期日。
5. 在“你的问题”中输入问题，点击“发送”。提问包含纽约当前日期、上次已加载的股票代码和问题，不采用尚未提交的行情表单修改。模型按需调用行情工具，表格不会因提问自动刷新。

日线展示全部返回行，没有额外的桌面行数截断。期权链显示当前筛选行数、所选到期日行数和总返回行数。请求全部到期日不等于获得完整市场链，提供商分页和行数限制仍然生效。

数值 `0` 保留为零，`null` 显示为“缺失”。IV 在数据中是年化小数，表格换算为百分比。PUT、CALL、IV、Greeks、OI、股票代码、OCC 标识、模型名和原始诊断保留原文。“实际工具调用”面板只显示实际收到的工具事件，不把普通模型文本当作工具执行证据。

“加载”和“发送”共用一个活动操作。忙碌时不接受第二个操作，也不排队。行情和问题草稿独立保存，不因流式回复覆盖。行情数据没有变化时，流式回复不会重建行情表格 DOM。

“停止”取消当前操作并结束 Pi 子进程，不只是暂停生成。“重启 Pi”启动全新会话，清空对话、工具日志和上次加载的行情，保留未发送的问题草稿及行情表单草稿，不自动重新取数。关闭窗口也会结束 Pi。崩溃不自动重试、重启或切换模型，错误留在界面中。

## 配置模型与认证

默认模型为 `openai-codex/gpt-6.1-sol`。先在独立终端运行 Pi，再在交互界面执行 `/login openai-codex` 完成认证。认证由 Pi 管理，桌面不提供登录表单。

Pi 默认把认证保存在 `~/.pi/agent/auth.json`。设置 `PI_CODING_AGENT_DIR` 时，登录和桌面启动必须使用同一目录。不要把模型凭据复制到应用目录。

更换模型时指定完整标识：

```bash
OPTION_AGENT_MODEL=openai-codex/gpt-6.1-sol bun run start
```

`OPTION_AGENT_PI_BIN` 指定外部 Pi 可执行文件，默认 `pi`。找不到程序、缺少资源或实际模型不匹配时，应用报错，不静默回退。

配置解析、启动预检和每轮扩展门禁都拒绝含 `anthropic` 路径段的模型，包括 `openrouter/anthropic/...`。这只约束 Pi 模型标识，不能证明自定义代理服务的真实上游或账单。

`--offline` 关闭 Pi 的自动联网行为，不代表模型离线运行。用户发送问题后，Pi 仍可向已配置的模型 provider 请求推理。用户点击“加载”或模型调用行情工具时，扩展也可请求行情 provider。

## 配置行情凭据

生产行情服务只从以下规范文件读取 `POLYGON_API_KEY`：

```text
/Users/szou/Python/Playground/ClaudeTradingSkills/data/polygon/.env
```

按用户要求，不接受进程环境中的 `POLYGON_API_KEY`。不要通过 `export POLYGON_API_KEY=...` 配置本应用。启动 Pi 子进程时，应用移除 `POLYGON_API_KEY` 和 `MARKET_DATA_ENV_FILE`，凭据由扩展内的数据服务按需读取。

独立数据服务和手动探针也使用同一个规范文件。`MARKET_DATA_ENV_FILE` 不能选择其他文件，若设置，只允许解析到上述相同路径。加载器拒绝符号链接路径、超过 16 KiB 的文件、重复 key 和非法格式，不执行 `.env` 内容。

凭据缺失时，有效缓存仍可读取。需要联网但无法读取凭据时返回 `unavailable`，不伪装为空链。key 使用 Bearer 请求头，不进入 URL、RPC、IPC、渲染器、缓存或诊断。不要把 key、认证文件或原始带凭据响应加入仓库。

## 四层结构与所有权

| 层 | 主要位置 | 职责与边界 |
| --- | --- | --- |
| L4 桌面 | `src/main.ts`、`src/preload.ts`、`src/desktop.ts`、`renderer/` | 窗口、白名单 IPC、DTO 投影、中文对话和行情表格。渲染器没有 Node 权限。 |
| L3 业务与知识 | `src/business/types.ts`、`src/business/market-data/`、`skills/` | DTO、查询校验、归一化、行情访问、缓存和原生技能。 |
| L2 扩展与胶水 | `src/agent/`、`extensions/option-agent/index.ts` | 外部进程、JSONL、请求关联、生命周期、工具和命令注册、模型及预算门禁。 |
| L1 平台 | 外部 `pi --mode rpc`、Electron | 原样使用，不嵌入 Pi SDK，不增加 HTTP broker。 |

采用[设计方案 B](docs/design.md)。一个 Pi 扩展按需创建一个 `MarketData`，桌面命令与模型工具共用它和同一个缓存写者。桌面行情因此依赖 Pi 进程就绪。手动探针和离线测试使用独立缓存目录。

L3 的数据存取目录是运行时依赖例外。`client.ts` 可以使用 Node 读取规范凭据，`cache.ts` 可以使用 Node 做文件与哈希操作。`normalize.ts` 只导入类型，不使用 Node，不执行 I/O。其他 L3 模块不允许运行时导入，数据存取模块也不能依赖 L2 或 Electron。[架构测试](tests/architecture.test.ts)检查这些边界、渲染器类型导入和无 Pi SDK 依赖。

## RPC 与工具契约

行情表格经过无模型命令链路：

```text
行情表单 → preload.send({kind:'market', query})
         → 主进程校验窗口、主 frame、页面 URL 和查询
         → PiDriver.loadMarket → 外部 pi --mode rpc
         → /option-market <含 requestId 的 JSON>
         → 扩展内 MarketData → appendEntry('option-market-result/v1', DTO)
         → handled ACK + 匹配 entry → AgentView.market → 表格
```

`/option-market` 支持 `market`、`contract` 和传输检查用的 `echo`，都不启动模型轮次。桌面目前只提供加载日线与期权链的入口，没有单合约查询表单。驱动的 `loadContract(occ)` 和模型工具可以查询单合约。

对话经过技能链路：

```text
问题 → 白名单 IPC → PiDriver.ask
     → /skill:option-coach <纽约日期、已加载股票代码、问题 JSON>
     → 模型文本与实际工具事件 → agent_settled → DTO → 界面
```

RPC 响应按 `id` 与 `command` 双重匹配。行情命令必须收到 `handled` ACK 和匹配 requestId、action、query 的合法结果。对话必须收到 `started` ACK 和成功的 `agent_settled` 才恢复空闲，单独的 `agent_end` 不算完成。命令外层 `status: ok` 只表示协议成功，日线与期权链各自仍可能是 `partial`、`unavailable` 或 `error`。

扩展允许以下工具：

| 工具 | 能力与限制 |
| --- | --- |
| `read` | 只读本应用 `skills/` 内真实文件，拒绝目录穿越和符号链接。 |
| `hello({name})` | 检查工具传输，不查询行情。 |
| `get_daily_bars({symbol, days})` | 返回最多 500 根日线，模型文本包含全部返回日线，包含请求的完整 20 天历史。 |
| `get_option_chain({symbol, expiry?, side?, strikeRange?})` | 有界期权链。`side` 可选，仅接受 `'put'` 或 `'call'`。明确请求 PUT 或 CALL 时分别传入对应值，先过滤再截取模型文本的最多 10 行。文本给出 `totalRows`、`shownRows`、`omittedRows` 和缩小类型、到期日或行权价范围后重查的提示，前 10 行不代表完整链。结构化 details 保留全部返回行。 |
| `get_contract({occ})` | 一个经 OCC 身份校验的合约快照。 |

每次提问最多 12 轮、24 次工具调用。行情工具顺序执行。自动重试、自动压缩和缓存预热关闭。JSONL 字节上限、严格 UTF-8、请求超时和退出清理由 L2 执行。

## 知识、上下文与权限

Pi 只显式加载本应用的扩展与技能，不发现其他扩展、技能、MCP、提示模板或上下文文件。入口 [option-coach](skills/option-coach/SKILL.md) 要求先完整读取两条原则：

- [事实优先](skills/principle-facts-over-heuristics/SKILL.md)要求区分事实、来源、时间、假设和缺失数据，不编造价格或指标。
- [只给建议](skills/principle-advice-not-orders/SKILL.md)把交易执行留给用户和 private banker，不把草稿说成邮件已发送或订单已成交。

原生技能是知识，不是权限。代码门禁负责工具白名单、读取范围、模型限制和预算。主进程只接受拥有窗口的主 frame 发出的 IPC，其他窗口即使使用相同 URL 和 preload，也不能控制会话。

渲染器把模型文本和工具输出当作字面内容，不解析 HTML。sandbox、context isolation 和 CSP 禁止渲染器访问 Node、执行内联脚本或连接网络。外部 Pi 和扩展仍以当前用户权限运行，不是操作系统级沙箱。

## 行情接口、缓存与数据语义

服务标识为 Massive，当前请求固定发往 `https://api.polygon.io`。桌面与模型共用以下接口和 TTL：

| 数据 | endpoint | 缓存 TTL |
| --- | --- | --- |
| 日线 | `/v2/aggs/ticker/{symbol}/range/1/day/{from}/{to}` | 纽约工作日 09:30 至 16:00 为 60 秒，其余为 4 小时。含暂定日线时最多 60 秒。 |
| 期权链 | `/v3/snapshot/options/{symbol}` | 30 秒。 |
| 单合约 | `/v3/snapshot/options/{symbol}/{occ}` | 30 秒。 |
| 市场假日 | `/v1/marketstatus/upcoming` | 24 小时。 |
| 一个月国债利率 | `/fed/v1/treasury-yields` | 6 小时。 |

`optionChain` 与 `/option-market` 的 `query` 都接受可选 `side: 'put' | 'call'`，传给提供商的参数为 `contract_type`。省略时保留混合链行为。不筛选、PUT、CALL 分别使用独立的并发查询、磁盘缓存和 RPC 身份。

日线请求固定使用 `adjusted=true`，OHLC 和成交量均为提供商调整后的值，可能包含小数。“调整后成交量”不是未经调整的原始成交股数，不应取整或按原始股数解释。

日线的 `provisional` 保守地表示该行日期与 `fetchedAt` 的纽约日期相同，不代表已确认官方收盘时间。即使常规收盘钟点已过，同日行仍标为暂定，缓存最多 60 秒。日线 TTL 只按纽约星期和钟点判断，不使用真实假日或提前收市日历。假日与国债方法已在服务中实现，目前没有桌面入口或模型工具，且没有做真实接口验证。

默认缓存位于本应用 `.local/data/`，最多 128 条，每条小于 900,000 字节。缓存只保存校验通过的 `ok` 或 `empty` 结果，校验查询、身份和时间后才复用。写入采用原子替换。`partial`、`unavailable` 和 `error` 不入缓存，写入失败也明确报告为部分结果。

每次 HTTP 请求默认超时 10 秒，响应上限 512,000 字节。生产查询最多 4 页、累计 1,000 个原始行，期权链每页请求 250 行。超出边界时保留可用行并报告 `partial`，不能把结果当作完整期权链。拒绝重定向，分页只接受相同 origin 和 endpoint 路径，循环或不安全的分页会停止。服务合并相同的并发查询，每个调用者获得独立结果副本。

`DataResult<T>` 明确区分以下结果：

| status | 含义 |
| --- | --- |
| `ok` | 有合法数据，未发现已知缺失或截断，不保证实时性。 |
| `empty` | 提供商返回有效空结果，没有匹配数据。 |
| `partial` | 数据不完整、缺字段、后续页失败、触达限制或缓存写入失败。可保留可用行。 |
| `unavailable` | 凭据、权限、限流或提供商可用性限制使数据不可用。 |
| `error` | 请求、超时、解析、校验或取消失败。 |

提供商故障意味着数据不可用，具体错误可能映射为 `unavailable` 或 `error`，不能解释为“没有匹配合约”。缺失 bid、ask、IV、Greeks 或 OI 保留为 `null`。数据权限可能导致缺字段，服务不能仅凭缺失判断原因。

每组结果分别显示 provider、source、asOf、fetchedAt 和 issues。“来源”为网络或缓存。“获取时间” `fetchedAt` 记录发起本次取数的时间，命中缓存时保留原值，不改成当前读取时间。“数据截至” `asOf` 来自数据时间，期权取返回行中最新报价时间，单行 `quotedAt` 才是该合约的报价时间。日线 `asOf` 是最新一根日线的开始时间，不是收盘确认时间。不要把网络取数、缓存有效或 `ok` 状态当作最新实时报价的证明。

## 离线验证与已有证据

在本目录运行：

```bash
bun run typecheck
bun test
bun run build
bun run test:smoke
```

| 命令 | 验证范围 | 真实模型或行情 |
| --- | --- | --- |
| `bun run typecheck` | strict TypeScript，包含测试与脚本。 | 无。 |
| `bun test` | RPC、进程、IPC、扩展、归一化、分页、缓存、缺字段、凭据边界、探针防误触和架构。 | 无，使用 fixtures 和临时目录。 |
| `bun run build` | 实际 main、preload、renderer、HTML 和 CSS。 | 无。 |
| `bun run test:smoke` | 两组真实 Electron 加 fake-pi 检查，fake-pi 执行实际扩展和 fixture-backed 数据客户端。 | 无。 |
| `bun run verify:pi` | 真实 Pi 加载器、模型元数据、五项资源和关联 echo。 | 不发起模型轮次，不请求行情。 |

最终验收通过 `bun run typecheck`、528 个离线测试、`bun run build` 和两组真实 Electron smoke。输出保存在 `artifacts/final-verification.log`。独立复核发现的技能兄弟路径误拦、PUT 摘要不可见和未来报价时间问题均已修复，并有回归测试。

离线单元测试不读取真实凭据，不调用真实行情。Smoke 需要图形会话，会操作真实窗口，运行时不要向测试窗口输入内容。两组 smoke 都只允许显式 `tests/fake-pi.ts`，缺失即失败，不回退到真实 Pi。它们使用临时 Electron profile、隔离 Pi 目录和环境白名单。

最终 `artifacts/electron-smoke.assertions.json` 和 `artifacts/market-smoke.json` 记录 16 项与 10 项检查通过。覆盖启动无 prompt 或行情请求、中文默认界面、实际工具结果、表格与本地筛选、缓存来源、缺失与不可用状态、忙碌与生命周期、草稿保留、IPC 拒绝、XSS 字面展示、Node 与 CSP 隔离、子进程清理。行情 smoke 另检查流式回复期间未变化的行情表格零 DOM 变动。

截图为 `artifacts/electron-smoke.png` 和 `artifacts/market-smoke.png`。其他产物包含 fake-pi 记录、Electron 诊断和网络观察，全部在 gitignore 排除的 `artifacts/` 中。被 CSP 拦截的请求尝试可能出现在 Playwright 事件中，成功联网证据要看实际响应或本机监听器命中数，不能只看 request 事件。

真实 Pi 探针已在空凭据环境通过，`turn_start=0`，输出见 `artifacts/final-pi-probe.log`。`verify:pi` 拒绝明显的 fake-pi 路径，但不证明 OAuth 有效、真实模型回答、工具选择或建议质量。`probe-pi.ts` 继承调用者的 Pi 配置，不自行创建隔离目录。若只验证加载器和 echo，可显式隔离：

```bash
probe=$(mktemp -d)
mkdir "$probe/agent"
env -i PATH="$PATH" HOME="$probe" TMPDIR="${TMPDIR:-/tmp}" \
	PI_CODING_AGENT_DIR="$probe/agent" bun run verify:pi
```

临时目录由调用者管理。普通 `bun run verify:pi` 不提供这层配置隔离。

## 手动 Massive 探针

只有明确传入 `--run` 才会创建生产客户端并请求真实行情。导入脚本、默认 `bun test` 或不带 `--run` 执行均不会启动探针。

以下命令会产生外部请求，仅在明确需要时手动运行：

```bash
bun scripts/probe-massive.ts --run
```

可选 `--symbol AAPL` 和 `--expiry YYYY-MM-DD`。默认请求 20 根 AAPL 日线，再按最新日线收盘价上下 1% 查询期权链，最后查询第一个可用 OCC 合约。默认到期日为纽约日期的本周五或下周五，不按假日调整。遇到已知假日例外时显式指定到期日。

探针使用独立新缓存目录，累计最多 3 次实际 HTTP 尝试，失败尝试也计数。每个查询最多 1 页，不重试，不为补足数据追加请求。空结果或不可用结果失败，仍有可用行的部分结果会保留限制。探针不调用模型、不下单，也不查询假日或国债。

终端只输出状态、请求数、行数、缺字段计数和产物路径。`artifacts/massive-probe.json` 原子写入规范化查询、数据、时间、检查点、缺字段计数和限制，不保存凭据或原始 HTTP 响应。

本次只运行了一次真实 Massive 探针，启动时间为 `2026-11-02T00:32:19.767Z`。独立复核及其后修正使用离线证据，没有重复请求：

| 项目 | 观察结果 |
| --- | --- |
| 实际 HTTP 尝试 | 恰好 3 次，上限 3 次。 |
| 日线 | AAPL，20 行，`ok`。 |
| 期权链 | 到期日 `2026-11-06`，6 行，`ok`。 |
| 单合约 | `O:AAPL261106C00342500`，1 行，`ok`。 |
| 缺字段 | 记录的日线成交量及全部期权期望字段缺失计数均为 0。 |

探针于 11 月 2 日取数，但报价时间仍为 `2026-10-30`，期权链 `asOf` 为 `2026-10-30T20:00:00.496Z`。这证明当次窄范围请求成功，不证明实时报价、新鲜度、全部到期日、所有标的权限或接口长期可用。真实假日和国债接口仍未验证。

## 尚未完成

- Stage 2 技术指标、支撑阻力和趋势分析。
- Stage 3 Black-Scholes、交易日时间处理、scenario grid 与限价计算。
- Stage 4 单腿 STO、ROLL、BTC 策略筛选，以及 Stage 5 双腿价差。
- Stage 6 Portfolio、本地成交进度和月度对账，以及 Stage 7 风险控制。
- 邮件发送、券商接口、账户接入和任何实盘交易能力。原生技能不会授予这些能力。

维护入口见[实施计划](IMPLEMENTATION_PLAN.md)、[设计说明](docs/design.md)和[追加式决策日志](docs/decisions.tsv)。
