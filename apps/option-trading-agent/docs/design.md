# Stage 0 和 Stage 1 设计

## 完成条件

每阶段通过 `bun run typecheck`、离线 `bun test`、`bun run build` 和真实 Electron 加 fake-pi 的 `bun run test:smoke`，然后本地 commit。Stage 1 另运行最多三次 HTTP 调用的真实 Massive 探针。Stage 2 暂不实施。

## 参考覆盖

主代理读取 tilldone 的 config、rpc、jsonl、domain、完整白皮书、fake-pi 和 Electron smoke，blackjack 的 README、整个 src/agent、扩展入口和 probe-pi。只读探索代理完整读取简报第 3 节的 chess 技能及其 references、四层契约讨论、blackjack 技能和全部 tests，以及 ClaudeTradingSkills 六组技能、白皮书、provider client 和 pi-trading-agent 的六个 domain 文件、工具、Polygon client、课文。Pi 的 RPC、扩展、技能文档和相关 CLI 协议经只读探索核实。

## 调用者视角

桌面加载标的时通过白名单 IPC 调用 `PiDriver.loadMarket`。它发送 `/option-market <关联 ID 与查询 JSON>`。扩展调用 L3 数据服务，通过 `appendEntry` 发回 DTO，prompt ACK 必须为 `handled`。此路径不调用模型。

提问时发送 `/skill:option-coach <问题和当前日期>`。原生 read 仅允许技能目录。领域工具调用相同服务。桌面只投影消息和实际工具事件，等 `agent_settled` 后恢复空闲。

## 数据形状

`DataResult<T>` 使用 `status` 区分 ok、empty、partial、unavailable、error，包含 provider、asOf、fetchedAt、source、rows、issues。失败与有效空响应不同。缺失数值是 null，不是零。报价时间与取数时间分开。IV 和国债利率使用年化小数。

`DailyBar` 包含交易日、OHLC、成交量。`OptionSnapshot` 包含 OCC、标的、到期日、方向、行权价、bid、ask、IV、Greeks、OI 和报价时间。市场假日保留提前收市信息。

操作状态用 idle、market、advice、failed、closing 表达。一个窗口、一个 Pi 进程、一个活动操作。扩展内一个数据服务写缓存。手动探针使用独立缓存目录。

## 候选方案

| 候选 | 所有权 | 优点 | 代价 |
| --- | --- | --- | --- |
| A | Electron 宿主持有服务，扩展通过临时 token 的 loopback HTTP 请求 | Pi 故障不影响市场表格 | 多一个服务、鉴权与生命周期 |
| B | Pi 扩展持有服务，桌面命令与工具共用 RPC 和服务 | 单一 provider 实现、缓存写者，无新增传输 | 市场表格依赖 Pi CLI，需验证 handled 与 entry_appended |

两个独立只读设计候选给出了调用示例、类型、模块、替代方案和测试设计。按无 SDK、单写者、缺数据语义、离线可验证性、维护成本五项评审。优先 B。保留 A 的真实扩展执行 fake-pi 测试设计和独立字段时间。拒绝 HTTP broker、通用 provider registry、Blackjack 的行动提案提交协议。这里不下单，不需要移植牌局门禁。

先以真实 Pi 无模型探针验证 B 的命令与 entry 传递。若协议不成立，再改选 A，而非猜测或自造 stdout 协议。

## 工作顺序

1. Stage 0 定义 DTO、RPC 和 hello 工具，建立真正执行扩展的 fake-pi、构建与 Electron smoke。
2. 检查 diff、清理无用注释、验收并 commit Stage 0。
3. Stage 1 增加 Massive provider、归一化和缓存，扩展命令及工具，桌面日线和期权链。
4. 验证离线解析、分页、权限、缓存、缺字段、泄密边界与 Electron，然后运行三次调用上限的真实探针。
5. 审计和独立复核，再 commit Stage 1。只汇报，不创建 PR、不 push。

## 吞吐检查点

- Blocking first steps. 所有参考读取、DTO、RPC 与真实桌面 smoke 在市场数据之前完成。
- Independent workstreams. 参考读取并行，设计候选只读。代码每阶段一个实现负责人，主代理审查与运行验证。
- Shared mutable state. 只有扩展数据服务写生产缓存。探针、测试各自隔离目录。主代理独占 git commit。
- Smallest safe decomposition. 两个有独立验收和 commit 的 Stage。不做 Stage 2、下单、账户、SDK 或额外 daemon。

## 安全与局限

只从指定 `/Users/szou/Python/Playground/ClaudeTradingSkills/data/polygon/.env` 读取 key。覆盖环境路径必须指向同一文件，不接受任意凭据源。默认测试注入 fixtures，不读取该文件。key 不进入 RPC、IPC、缓存或错误文本。fetch 禁止重定向，分页只允许 Polygon 原始 host 和 endpoint 路径。

扩展拥有用户权限，不是操作系统沙箱。自定义 provider 的实际计费无法由名字完全证明。默认 Codex，启动前及实际模型状态检查拒绝任何 anthropic 路径，不静默替换。

外部数据计划可能不包含实时 bid/ask 或国债利率。partial 和 unavailable 是可展示结果，不表示可以做交易决策。没有实盘执行、技术指标、定价全景图或策略筛选。
