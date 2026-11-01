# 原生 Skill 与内置工具（v3）

## 设计更正

早期实现先禁用了内置工具，再用 `SkillCatalog`、`read_skill`、宿主拼接索引和全文注入来补足 Skill 能力。虽然复用了 Pi 的解析函数，宿主仍承担了一套 Skill 支持机制。这不是本项目的设计目标。

**当前原则：使用 Pi 原生 Skill；不为 Skill 自建加载器、读取协议、路径注册表或授权子系统。**

## 当前运行方式

- `DefaultResourceLoader` 的 `noSkills: true` + `additionalSkillPaths: [workspace/skills]` 只配置技能发现来源，不禁用显式路径。用户目录、项目 `.pi/skills` 和设置注入的其他技能不自动加载；这不是文件访问隔离。
- 开放原生 `read/bash/edit/write`，另加 8 个象棋业务工具。不再设置 `noTools: 'builtin'`，也不把工具白名单限制成只有象棋工具。
- Pi 自动生成 `<available_skills>` 及真实文件路径，模型用原生 `read` 读取技能和相对 references。宿主不再调用 `formatSkillsForPrompt`、`stripFrontmatter` 或改写 location。
- 每回合用 `session.prompt('/skill:xiangqi-coach ' + turnPrompt(state))`，由 Pi 原生展开入口。入口全文在用户消息，不再由宿主读入系统提示词。系统提示词保留棋手身份、业务权威与目录操作约定。
- 19 项技能均进入原生索引。七个剧本不再设 `disable-model-invocation: true`。`turnGuidance()` 仍计算应将、棋钟、受攻大子和阶段，但只提供**业务建议剧本及依据**，不再选择并拼接一份全文。模型按需读取，不宣称建议等于加载或遵循。
- 删除 `src/agent/skill-loader.ts`、`SkillReader` 和专用 `read_skill`。完整性清单仅保留在测试中。驱动仅检查 Pi diagnostics 和入口存在，以便缺失资源时在请求模型前明确失败。

## 项目目录与权限

开发启动的工作目录是 `apps/chinese-chess`，不再是 Electron `userData` 根目录，也不是启动 harness 时的目录。

安装包内的 asar 不是可写 shell 工作区。安装版使用 `userData/chinese-chess` 作为独立项目工作区，把随应用分发的 `skills/` 复制到其中。已有文件不覆盖，保留本地编辑；新增文件会补齐。升级后已有技能不会自动替换，需用户自行同步新版本。棋谱、案例库和认证仍由宿主按原路径管理，不移入此工作区。

提示词要求所有文件操作和脚本只在当前项目目录内，不访问外部路径或凭据，不修改裁判代码、棋谱和权威状态来绕过业务校验。

**这是行为约定，不是强制隔离。** Pi 1.4.0 的 `cwd` 只决定默认目录；原生工具仍拥有宿主进程的 OS 权限，绝对路径、`../`、软链和 shell 都可能越界，环境变量也可能含凭据。本次没有添加路径过滤器、命令过滤器或沙箱，更不保证“只能访问项目目录”。如需硬边界，应另接现成 OS 沙箱或容器，不能把 `cwd` 或资源发现配置当作安全边界。

开放写入还意味着模型可能修改项目文件，包括下回合会加载的技能；仅应在可信环境运行并审阅改动。

## 业务权威、预算与记录

- 规则、棋钟、revision、搜索和独立提交复查不变；落子与认输仍只能由业务服务接受。文件修改不是合法提交接口。
- 模型请求总上限调整为10次（8+2）；16次工具调用预算不变。内置工具也经过 `tool_call` 守卫、计入预算和耗时。前8次模型请求用于分析与必要读取，第9–10次仅声明 `move_piece/resign_game`，预留提交及一次纠错机会；16次工具预算耗尽也不移除这两个出口。参见[第33手请求预算故障调查](2026-10-31-request-budget-review.md)。
- 成功落子或认输后中止回合，取消和棋钟超时继续传播到 Pi 和异步业务工具。
- 新记录版本为 `xiangqi-skills/v3`，旧 v1/v2 仍可展示。`playbook` 表示业务建议，`skillsInjected` 仅记录 Pi 展开的入口 `xiangqi-coach`。旧字段 `skillsRead` 保留为空，不再维护专用技能读取追踪器。
- 原生读写、shell 和业务工具仍记入 `tools: {name, ok}[]` 与 timing，旧tools数组为完成顺序；新增可选 `decision.audit` 按开始顺序记录所属请求、技能Markdown逻辑路径/读取范围、候选/计划摘要、输入/返回指纹及重复关联。公开字段白名单、不存原始输出和助手思考；不推测 `bash` 内是否读取过技能。证据和隐私边界详见[调用审计](call-audit.md)。
- 本次不宣称棋力提升、真实模型更快或缓存命中改善。19 项原生索引与实际路径增加了前缀字符，历史 v2 的字符数字不能直接作为 v3 数据。

## 验证范围

`bun run check` 执行类型检查、全部离线测试和构建。真实 Pi + 本地 SSE 用例验证原生索引与 `/skill` 展开、技能/reference 读取、缺失文件纠错、原生写入/编辑/bash/read、工作目录、共享预算、审计、成功终止与取消。调用本地测试替身，不消耗供应商额度；目录约定的测试不证明硬隔离。

已运行验证：

- `bun run check`：TypeScript、19 个文件共161项测试（0失败）、生产构建通过。
- `bun run test:smoke`：开发版真实 Electron 冒烟通过。
- `bun run pack` + `just smoke-dist`：mac-arm64 打包及安装版真实 Electron 冒烟通过，覆盖 asar 资源复制到独立工作区后由 Pi 原生 loader/read 加载。
- `git diff --check`：通过。

Electron UI 落子仍是显式 fixture，不是实战评测；未调用外部真实模型。原白皮书 PDF 为 v2 历史快照，本次只更新 Markdown 的设计更正，不自动重生成 PDF。
