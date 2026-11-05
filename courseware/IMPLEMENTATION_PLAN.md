# IMPLEMENTATION_PLAN：互动课件的来源同步与 AI 助教勘误

## 目标

让 interactive-courseware 模板生成的课程**自己发现“课文和来源不一致”**，而不是靠作者偶尔跑一次学员验收。改动全部放在模板和 learner driver 里，和课程内容无关：来源可以是代码仓库、文章、论文或笔记。

## 为什么做

两轮学员验收（《边牧结构精读》，2026-11-04，报告见 `tilldone-desk/docs/reviews/2026-11-04-learner-review.md`）共发现 12 处内容问题。原因分四类：

| 原因 | 证据 | 对应阶段 |
|---|---|---|
| 助教拿不到这一课引用的来源 | L04 讲 `spent` 却拿不到 `state.ts`；L05 讲桌面端逻辑却拿不到 `domain.ts` | 阶段 1 |
| 课文写错，助教先发现了 | E-L4 已删、pstack 有 4 个钩子、计费门“更严”的条件 | 阶段 2 |
| 来源变了，课文没跟上 | 快照后来源有 3 个提交；27 处行号引用偏移 | 阶段 3 |
| 演示在终点状态下出错 | L06 播放器把 `allDone` 之后落空的调用算成成功 | 阶段 4 |

## 范围

- 模板：`~/.claude/skills/interactive-courseware/`（`assets/template/`、`scripts/learner-driver/`、`SKILL.md`、`references/`）。
- 同步到两门现有课程：`courseware/tilldone-desk/`、`courseware/five-llm/`。
- 不做：锚点引用、助教检索工具、说理由式自测、笔记失效提醒、作者热点图（理由见报告第 5 章和验收结论，两轮都没有碰到对应问题）。

## 约束

- **模板目录不在 git 里。** 动手前把 `~/.claude/skills/interactive-courseware/` 整个复制一份备份，记下备份路径。
- **AI 助教走 DeepSeek 官方 API，按量计费。** 自动化测试不调用 DeepSeek。需要真实助教回答的验收（learner driver）每个阶段最多 6 问，跑完删掉测试笔记。
- **不要用 `anthropic/*` 模型跑任何第三方 harness。** 用户的 Anthropic API 没有充值。
- Python 用 `uv run`；不引入新依赖，单元测试用标准库 `unittest`。
- 每个阶段结束：单元测试通过，两门课 `check_page.py` 三个主题全部通过，然后提交（只提交仓库里的课程改动；模板改动在报告里列出）。
- 课程页面的类名和 learner driver 的选择器是一对。改了模板类名，同步改 `learn.py`。

## 共用数据形状

阶段 1–3 都围绕一份“来源清单”，放在每门课的 `lessons/tools/sources.json`。它取代 `serve.py` 里手写的 `SOURCES` / `EXTRA`，让 `serve.py` 在各门课之间完全一致，模板改动可以直接复制过去。

```json
{
  "sources": [
    {
      "id": "article",
      "label": "原文《边牧结构梳理》",
      "path": "docs/articles/tilldone-desk-anatomy.md",
      "scope": "all",
      "snapshot": { "kind": "file", "sha256": "…" }
    },
    {
      "id": "state-ts",
      "label": "扩展 L3 源码 state.ts",
      "path": "../../apps/tilldone/extensions/tilldone/state.ts",
      "scope": "cited",
      "aliases": ["state.ts"],
      "snapshot": { "kind": "git", "commit": "8c2f42e" }
    }
  ]
}
```

- `path` 相对项目根目录（与现有 `SOURCES` 一致）。
- `scope`：`all` 每课都带；`cited` 只在课文提到它时带；也可以是课程文件名列表。
- `aliases`：课文里可能用到的写法，例如文件名、原文书名、小节前缀。
- `snapshot`：阶段 3 使用。`git` 记提交号，`file` 记内容哈希。

## Stage 1: 来源清单与按引用配置助教资料

**Goal**：每课的助教自动拿到这一课引用的全部来源，不再手写 `EXTRA`。

**Success Criteria**：
- `serve.py` 从 `sources.json` 读取来源；两门课迁移后，各自 `serve.py` 与模板逐字相同。
- 课文提到某个 `cited` 来源的 `path` 或任一 `alias`，这一课的助教就带上它。
- 来源总长超出预算时，按 `all` → 课文提到次数多的 → 其余的顺序保留，并在系统提示里写明省略了哪些。
- `finalize.mjs`（或新的 `tools/check_sources.py`）列出课文里像文件或来源的引用、但没有登记在 `sources.json` 里的条目，作为警告。

**Tests**：
- `tools/test_sources.py`（unittest）：`scope` 三种取值；按 alias 命中；不命中不带；超预算时的保留顺序。
- 边牧：L04 的助教上下文包含 `state.ts`，L05 包含 `domain.ts`（用一个只构建消息、不发请求的函数断言）。
- learner driver 抽查 2 问：在 L04 问切换分支后 `spent` / `nudged` 怎样，在 L05 问交还提示的条件。回答要引用源码，而不是“原文没给”。

**Status**: Complete
- 课程配置（课程名、前缀、端口、人设、课程规则）也移进 `sources.json` 的 `course` 段，两门课的 `serve.py` 与模板逐字相同（`scripts/sync_course.py --check`：0 个文件不同）。
- scope 列表的含义：列出的课一定带，其余课文提到时也带。
- 检查入口是 `serve.py --check`：列出每课的资料、超预算省略项、资料缺失（报错）和没登记的引用（警告）。
- 测试：模板 20 个 unittest 通过；两门课 check_page 三主题全部通过（边牧 10 页、弈境 13 页）。
- learner driver 3 问：L05 引用 `handoffView` / `judgeNudges`（`domain.ts`）。L04 第一次答对内容但自称“state.ts 没附”，系统提示随后在资料前列出“本课附带的资料”，重问后引用 `toolCalled`（`state.ts:430`）。

## Stage 2: 勘误通道与读数一致性

**Goal**：助教发现课文与来源矛盾时，留下一条结构化勘误；推理和演示读数矛盾时明说。

**Success Criteria**：
- 系统提示新增两条规则：课文与来源矛盾时，在回答末尾输出一个 ```` ```errata ```` 代码块（JSON：`lesson`、`section`、`claim`、`evidence`、`source`）；分析与演示读数矛盾时，写明“演示读数与我的分析不一致”。
- `serve.py` 在回答结束后解析勘误块，去重后追加到 `lessons/errata.md`；`GET /api/errata` 返回列表。
- `course-tutor.js` 把勘误块渲染成“疑似勘误”卡片，不显示原始 JSON。
- 记笔记时勘误块不进笔记正文。

**Tests**：
- unittest：解析合法块、忽略坏 JSON、多块、去重。
- 用一个测试夹具课程（模板生成，课文故意写错一个数字）跑 learner driver 1–2 问，确认 `errata.md` 出现对应条目、页面显示卡片。

**Status**: Complete
- 勘误块里的 `lesson` 以服务端为准，不信模型填的；按“课程文件 + 去标点的课文原话”去重；写 `errata.md` 有锁。
- `learn.py` 每问记录 `.tp-errata` 卡片（`qa.json` 的 `errata`、`summary.json` 的 `errata`）。
- 测试：模板 28 个 unittest 通过；两门课 check_page 三主题全部通过（边牧 10 页、弈境 13 页）。
- 夹具课（原文“最多重试 3 次”，课文写成 5 次）1 问：助教按原文作答，`errata.md` 和 `/api/errata` 各出现 1 条，页面显示“疑似勘误”卡片。随后 1 次记笔记：笔记正文和原始对话附录里都没有勘误块。测试笔记已删除。

## Stage 3: 来源漂移哨兵

**Goal**：来源在快照之后变了，课程页和助教都知道。

**Success Criteria**：
- `uv run --no-project python tools/serve.py --snapshot` 把每个来源的当前指纹写进 `sources.json`。
- 启动时比对：`git` 来源用 `git log --oneline <commit>..HEAD -- <path>` 和 `git diff --stat`；`file` 来源比较哈希，变化时给出截断的文本 diff。
- `GET /api/drift` 返回变化列表；引用了已变来源的课程页顶部显示提示，列出变化的来源。
- 这一课的来源有变化时，助教系统提示里附上“来源自快照后的变化”摘要。
- 来源文件缺失时明确报出，不静默跳过。

**Tests**：
- unittest：临时 git 仓库（提交、改动、再提交）和临时文件（改内容）各一例；无变化时不报。
- 边牧：把 `sources.json` 里某个来源的快照改成旧提交，启动后对应课程出现提示，`/api/drift` 列出它；改回后提示消失。

**Status**: Complete
- `--snapshot`：文件在 git 里且没有未提交改动时记提交号，否则记 sha256 并把内容副本存进 `tools/.snapshots/`（点目录，静态服务不提供），以后才给得出文本 diff。git 来源的 diff 比的是工作区，未提交改动也算漂移。
- 两门课外部来源的快照记为已核对的提交（边牧 `8c2f42e`、弈境 `4f65e37`），课程自带文档记当前提交；pstack 的 `index.ts` 被 gitignore，记为 file。`--check` 当前无漂移。
- 漂移结果按 `sources.json` 的修改时间缓存，改快照不用重启服务。
- 测试：模板 41 个 unittest 通过（含临时 git 仓库、临时文件、缺失文件）；两门课 check_page 三主题全部通过（边牧 10 页、弈境 13 页）。
- 边牧验收：`domain-ts` 快照改成 `f112eb9` 后，`/api/drift` 列出 5 个提交（与学员验收报告一致），影响 L02/L03/L05/L06/L07；L05 顶部出现提示，L01 没有。助教 1 问“快照之后 domain.ts 改了什么”，答出各提交和 `addNudge` / `judgeNudges` / `handoffView`。改回后 `/api/drift` 为空，L05 提示消失。

## Stage 4: learner driver “推到终点”与文档、同步

**Goal**：learner driver 能自动把每个演示推到终态并请助教解释；模板文档与两门课同步。

**Success Criteria**：
- `learn.py` 新增 `settle` 动作：对指定小节（或全部）的每个演示，依次点击场景按钮、勾选每个复选框、点“播完”类按钮，记录每个终态读数；可选地对每个终态 `ask_card`。
- `scripts/learner-driver/README.md`、`SKILL.md`、`references/authoring-guide.md` 写明 `sources.json`、勘误、漂移哨兵、`settle` 的用法；AUTHORING 模板补“演示的简化假设要在终点状态下成立”。
- 两门课使用新版 `serve.py`、`course-tutor.js`，`check_page.py` 三个主题全部通过。

**Tests**：
- 对边牧 L06 运行 `settle`（不问助教）：TUI 门禁终态读数包含“未勾 1 项”。
- 两门课各跑一次 `settle`，无驱动错误。

**Status**: Not Started
