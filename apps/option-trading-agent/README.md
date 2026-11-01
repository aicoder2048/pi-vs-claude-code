# 期权交易助理

Stage 0 提供 Electron 对话窗口、外部 Pi RPC 和 `hello` 工具闭环。它只给建议，不下单，不接券商，不访问真实账户。

行情、期权链、技术分析、定价和仓位管理尚未实现。桌面的 Market data 区域只是占位，不代表已经连接 Massive。

## 启动

需要 Bun、just、可运行的 Electron，以及 PATH 中的 `pi` CLI。依赖版本见 [package.json](package.json)。本应用不安装或嵌入 Pi SDK。

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

看到 `Pi ready` 后输入问题，再点击 **Send**。启动不会自动发问。请求检查工具传输时，可以输入 `请调用 hello 工具检查连接，不要查询行情`。工具面板只展示实际收到的工具事件，真实模型是否选择调用工具由模型决定。

**Stop** 取消当前操作并关闭 Pi 子进程。**Restart Pi** 创建全新会话，清空对话和工具日志，但保留输入框中尚未发送的草稿。关闭窗口也会关闭 Pi。崩溃不会自动重试或换模型，错误会留在界面上。

## 模型与认证

默认模型为 `openai-codex/gpt-6.1-sol`。先在独立终端中运行 Pi，并在交互界面使用 `/login openai-codex` 完成认证。认证由 Pi 管理，应用不提供登录表单。Pi 默认把认证保存在 `~/.pi/agent/auth.json`。如果设置了 `PI_CODING_AGENT_DIR`，登录和桌面启动必须使用同一个目录。

更换模型时，设置完整的 provider 与 model 标识：

```bash
OPTION_AGENT_MODEL=openai-codex/gpt-6.1-sol bun run start
```

`OPTION_AGENT_PI_BIN` 可以指定外部 Pi 可执行文件。默认值为 `pi`。找不到可执行文件、资源缺失或实际模型不匹配时，应用报错，不回退到其他程序或模型。

配置解析、启动预检和每轮扩展门禁都拒绝包含 `anthropic` 路径段的模型，包括 `openrouter/anthropic/...`。这是对 Pi 模型标识的限制，不是对自定义代理服务真实上游和账单的证明。

Stage 0 不需要市场数据 key。不要把 key、OAuth token 或认证文件复制到本目录。当前 Pi 子进程会移除 `POLYGON_API_KEY` 和 `MARKET_DATA_ENV_FILE`。

## 四层结构

| 层 | 文件 | 职责与边界 |
| --- | --- | --- |
| L4 桌面 | `src/main.ts`、`src/preload.ts`、`src/desktop.ts`、`renderer/` | 窗口、白名单 IPC、状态投影、对话和工具日志。渲染器没有 Node 权限。 |
| L3 业务与知识 | `src/business/types.ts`、`skills/` | DTO、状态联合类型、原生入口技能及两条原则。当前没有行情服务或计算模块。 |
| L2 扩展与胶水 | `src/agent/`、`extensions/option-agent/index.ts` | 外部进程、JSONL 分帧、请求关联、生命周期、工具注册、读取范围和预算门禁。 |
| L1 平台 | 外部 `pi --mode rpc`、Electron | 原样运行。不嵌入 Pi SDK，不另建 HTTP broker。 |

`tests/architecture.test.ts` 检查 SDK 依赖、L3 运行时导入、渲染器类型导入和技能链接。L3 的 `market-data/` 为后续数据存取保留运行时依赖例外，其他业务模块不允许运行时导入。

## RPC 链路

对话经过以下链路：

```text
输入框 → preload.send({kind:'ask', text})
       → 主进程校验发送窗口、主 frame、页面 URL 和命令形状
       → PiDriver.ask → PiProcess → 外部 pi --mode rpc
       → /skill:option-coach <问题>
       → 文本事件、tool_execution_start、tool_execution_end
       → agent_settled → DTO → preload 订阅 → 界面
```

请求与响应按 `id` 和 `command` 双重匹配。对话必须收到 `started` ACK 和成功的 `agent_settled` 才恢复空闲。`agent_end` 单独到达不表示操作完成。忙碌时拒绝第二个问题，不排队。

扩展还注册 `/option-market <JSON>`。Stage 0 只支持带 `requestId` 的 `echo`，并通过 `appendEntry('option-market-result/v1', DTO)` 返回成功或错误。驱动同时等待 `handled` ACK 与对应 entry。这个命令不调用模型，也没有暴露为桌面行情功能。它验证后续由扩展持有行情服务的方案，不能作为行情接通的证据。

运行时只启用 `read` 和 `hello`，每次提问最多 12 轮、24 次工具调用。原生 `read` 受扩展限制，只能读取本应用 `skills/` 内的真实路径，拒绝目录穿越和符号链接。自动重试、自动压缩和缓存预热被关闭。JSONL 的字节上限、严格 UTF-8、请求超时和退出清理由 L2 执行。

## 知识与上下文契约

Pi 只显式加载本应用的扩展与技能，不发现额外扩展、技能、MCP、提示模板或上下文文件。对话入口为 [option-coach](skills/option-coach/SKILL.md)，要求先读取以下原则：

- [事实优先](skills/principle-facts-over-heuristics/SKILL.md) 要求区分来源、时间、假设和缺失数据，不编造价格。
- [只给建议](skills/principle-advice-not-orders/SKILL.md) 把交易执行留给用户和 private banker。草稿不等于已发送邮件或已成交订单。

技能提供知识，不授予权限。代码门禁负责工具白名单、预算和读取范围。主进程只接受拥有窗口的主 frame 发出的 IPC，第二个窗口即使使用同一 URL 和 preload，也不能控制会话。

渲染器把文本作为字面内容展示，不解析 HTML。sandbox、context isolation 和 CSP 禁止渲染器访问 Node、执行内联脚本或连接网络。外部 Pi 和扩展仍以当前用户权限运行，不是操作系统级沙箱。`--offline` 关闭 Pi 自动联网，不阻止用户发问后模型向已配置 provider 请求推理。

## 验证

在本目录运行：

```bash
bun run typecheck
bun test
bun run build
bun run test:smoke
bun run verify:pi
```

| 命令 | 验证范围 | 是否调用真实模型 |
| --- | --- | --- |
| `bun run typecheck` | strict TypeScript，包括测试与脚本 | 否 |
| `bun test` | RPC 分帧、关联、异常、进程清理、扩展门禁、DTO、IPC 参数、技能和架构 | 否 |
| `bun run build` | 实际主进程、preload、renderer、HTML 和 CSS 构建 | 否 |
| `bun run test:smoke` | 真实 Electron 与执行实际扩展的 fake-pi | 否 |
| `bun run verify:pi` | 真实 Pi 加载器、模型元数据、五项资源、无模型 echo 命令 | 否，不发起模型轮次 |

默认测试离线，不读取模型凭据或市场数据 key。`test:smoke` 只允许显式 `tests/fake-pi.ts`，缺失即失败。脚本不回退到真实 Pi。它使用临时 Electron profile、隔离的 `PI_CODING_AGENT_DIR` 和环境白名单，退出时清理临时数据。

Smoke 覆盖发送与回复、实际 `hello` 结果、工具日志、忙碌拒绝、Stop、Restart、Pi 崩溃、renderer 崩溃、窗口关闭、第二窗口 IPC 拒绝、非法命令、Node 隔离、CSP、无网络传输、XSS 字面展示和草稿保留。XSS 检查注入测试 DTO，验证渲染器投影，不声称真实模型生成了该文本。联网检查只使用本机监听器，断言 CSP 探测没有到达监听器。Playwright 仍可能报告被 CSP 拦截的请求尝试。

Smoke 需要能启动 Electron 的图形会话。它会操作真实窗口，运行时不要向测试窗口输入内容。产物位于被 gitignore 排除的 `artifacts/`：

- `electron-smoke.png` 保存成功对话与工具面板。
- `electron-smoke.assertions.json` 保存逐项断言、进程 PID、网络观察和总结果。
- `electron-smoke.fake-pi.jsonl` 保存假进程收到的请求和实际扩展钩子记录。
- `electron-smoke.stderr.log` 保存 Electron 诊断。
- `electron-smoke.failure.png` 仅在失败时保存，成功运行会删除旧的失败截图。

本轮验收通过 130 个单元测试和 16 项 Electron 检查。真实 Pi 无模型探针也已重跑通过，五项资源加载成功，关联 echo 的 ACK 为 `handled`，`turn_start=0`。探针输出见 `artifacts/pi-probe.log`。

`probe-pi.ts` 本身继承调用者的 Pi 配置，不创建隔离目录。本轮通过以下 shell 命令使用临时 HOME、隔离的 `PI_CODING_AGENT_DIR` 和空凭据环境运行，不读取原有认证文件：

```bash
probe=$(mktemp -d)
mkdir "$probe/agent"
env -i PATH="$PATH" HOME="$probe" TMPDIR="${TMPDIR:-/tmp}" \
	PI_CODING_AGENT_DIR="$probe/agent" bun run verify:pi
```

临时目录由调用者管理。普通 `bun run verify:pi` 不提供这层配置隔离。

上述结果不证明 OAuth 登录、真实模型生成、真实模型工具选择、行情权限或交易建议质量已经验证。

主代理复核时修复了窗口关闭和 renderer 崩溃后的更新时序。关闭清理开始前停止发布 DTO，避免向已销毁 frame 发送更新。修复后完整 smoke 重跑通过，对应诊断不再出现。根配方 `just option-trading-agent` 也已用 fake-pi 实际启动验证。

## 尚未实现

- Massive 请求、缓存、日线、期权链、合约快照、市场假日和国债利率。
- 技术指标、Black-Scholes、scenario grid、限价和策略筛选。
- Portfolio、本地成交记录、风险控制和邮件发送。
- 券商接口、账户接入及任何下单能力。

阶段状态见 [实施计划](IMPLEMENTATION_PLAN.md)。设计选择见 [Stage 0 和 Stage 1 设计](docs/design.md)，验收记录见 [决策日志](docs/decisions.tsv)。
