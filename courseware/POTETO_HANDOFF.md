/pstack:poteto-mode 按 courseware/IMPLEMENTATION_PLAN.md 实现互动课件的来源同步与 AI 助教勘误，四个阶段依次做，每个阶段结束更新计划里的 Status 并提交。

目标：interactive-courseware 模板生成的课程能自己发现“课文和来源不一致”。改动和课程内容无关，来源可以是代码、文章、论文或笔记。

背景与证据：courseware/tilldone-desk/docs/reviews/2026-11-04-learner-review.md（两轮学员验收，12 处问题的四类原因）。

要改的地方：
- 模板 ~/.claude/skills/interactive-courseware/（不在 git 里，动手前先整目录备份并报告备份路径）。
- 两门课 courseware/tilldone-desk/、courseware/five-llm/（各自的 lessons/tools/serve.py 目前只在课程配置段与模板不同）。

硬约束：
- AI 助教走 DeepSeek 官方 API，按量计费。单元测试不调用 DeepSeek；learner driver 验收每阶段最多 6 问，跑完删除测试笔记。
- 不在任何第三方 harness 里使用 anthropic/* 模型。
- Python 用 uv run，单元测试用标准库 unittest，不加新依赖。
- 每阶段结束：单元测试通过；两门课 check_page.py 在 light / dark / ink 三个主题全部通过；只提交仓库内的改动，不 push。
- 模板类名与 scripts/learner-driver/learn.py 的选择器成对修改。

完成后：删除 IMPLEMENTATION_PLAN.md（全部阶段完成时），在最终回复里列出模板改了哪些文件、备份在哪、每阶段的测试证据。
