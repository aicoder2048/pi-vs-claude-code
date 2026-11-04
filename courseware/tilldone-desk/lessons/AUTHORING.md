# 课程编写规范（给写课程的人和 AI 看）

本课程精读原文《边牧（TillDone Desk）结构梳理》。原文存档：`docs/articles/tilldone-desk-anatomy.md`（项目根目录下），它是**唯一事实来源**。
布局：左 = 学习路线与本课小节，中 = 图文课程，右 = AI 助教。

每篇课程 = 课程目录根下一个独立 HTML。双击就能打开（`file://`）；AI 助教需要本地服务 `tools/serve.py`。

**参考样板：`L01-*.html`（第一课写好后它就是样板）。** 写新课之前先完整读一遍它，照它的结构、组件和语气写。

## 1. 文件与目录

| 路径 | 用途 |
|---|---|
| `Lxx-*.html` | 课程页。文件名必须和 `assets/course-lib.js` 里 `CL.LESSONS` 的 `file` 一致 |
| `assets/course.css` | 公用样式。局部样式写在课程 `<style>` 里，只用 CSS 变量，不写死颜色 |
| `assets/course-lib.js` | 公用脚本 + 课程配置（`CL.STEPS`、`CL.LESSONS`） |
| `assets/course-tutor.js` | AI 助教前端（自动加载） |
| `assets/glossary-data.js` | 共用术语表 + 分类表 `CL_GLOSSARY_CATS` |
| `assets/glossary-add-<课号>.js` | 写课时新增术语的临时文件，最后由 `node tools/finalize.mjs --merge` 合并 |
| `img/figNN.*` | 原文配图（编号与原文顺序一致；在这里补一张“图号 → 原文位置 → 内容”对照表） |
| `tools/serve.py` | 本地服务 + DeepSeek 转发（`SOURCES` / `EXTRA` 配置原文） |
| `tools/check_page.py` | 真 Chrome 检查：JS 错误、坏链接、缺术语、演示没渲染、图片没加载、横向滚动 |
| `tools/finalize.mjs` | 合并术语、生成“出现在哪些课程”反向链接、报告缺失术语 |

## 2. 页面骨架（照抄 L01）

```html
<head>  course.css → glossary-data.js → [glossary-add-X.js] → course-lib.js
<header id="cl-topbar"></header>
<div class="layout">
  <aside class="toc"> 本课目录 <ol><li><a href="#s1">…</a></li>… </ol></aside>
  <main>
    .hero（kicker = "Lxx · 步骤名"，h1，一句导语，.meta）
    .objectives（学完本课，你能够：3–5 条，动词开头）
    section.lesson-sec#s1 … #sN   每节 h2 带 <span class="num">01</span>
    最后一节：自测（3–5 道 .quiz）+ 速记表 + 相关课程 .related
    <nav id="cl-pager" data-current="本文件名.html"></nav>
    <p class="disclaimer">原文出处 + “补充内容和模拟演示是课程作者的解释”</p>
  </main>
</div>
<script> CL.onReady(function(){ … }) </script>
```

## 3. 组件速查

- 原文配图：`<figure class="fig"><img src="img/fig04.jpg" alt="…"><figcaption><b>原文图 4</b>说明</figcaption></figure>`。点图放大；AI 助教自动加“问 AI”（把图片发给模型）。
- 原文金句：`blockquote.src` + `<cite>§2.1</cite>`，原样引用，少量。
- `.callout.rule` 核心规则；`.callout.note` 补充（**作者补充一律放这里，标题写“补充”**）；`.callout.tip` 提示；`.callout.warn` 局限/常见误解。第一行 `<span class="ttl">标题</span>`。
- `.grid-2 / .grid-3 > .kp`（`.k` 标签、`.v` 大字、`p`）；`.vs` 方案对照卡（`.good` / `.bad`）。
- `ol.steps`；`ul.checklist`；`.tbl-wrap > table.tbl`；`.pill.fast/.slow/.hot`；`.src-ref`。
- 互动演示：`.chart-card` > `.chart-head`（`.chart-title` + `label.ctrl` / `.btn`）→ `.demo#id` → `.readout` → `.chart-foot`。**结论数字写进 `.readout` 或 `.chart-foot`**，AI 助教才能读到。
- 时间线：`CL.lanes("#el", [{name, segs:[{t0,t1,cls:"c1".."c6",text}], ticks:[t]}], {t1, unit})`。
- 消息流：`ul.msgs > li.(drop|fast|slow|act)`，内含 `.src`、正文、`.verdict`。
- 内联 SVG：放在 `.diagram` 或 `.demo` 里，用 `.box .box.hl .box.dim .edge .edge.hl .edge.dash`、`text.sm`，自动适配主题。注意：共享样式会覆盖 SVG text 的 `fill="…"` 属性，特殊颜色用内联 `style="fill:…"`。
- `.quiz[data-answer=正确选项下标从0起]` > `.q` + `.opts > button…` + `.explain`。
- 术语：`<a class="term" href="glossary.html#id">词</a>`，ID 必须存在。课程互链：`<a href="L03-xxx.html#s3">`。

## 4. course-lib.js 速查

```js
CL.$("#id")  CL.$$(".x")  CL.fmt(x, 1)  CL.esc(s)  CL.pctl(arr, 95)
const r = CL.rng(42); r()      // 可复现随机数。小种子前几十个数会高低交替，需要时先丢弃约 50 个
CL.lanes(el, lanes, opts)      // 时间线泳道
CL.C.blue/orange/teal/purple/red/gray/gold/pink
CL.onTheme(fn)                 // 主题切换回调（JS 里用了颜色时重画）
CL.cssVar("--ink")
```

## 5. 术语表

- 先查 `assets/glossary-data.js`，有就用那个 ID。
- 没有：写进自己的 `assets/glossary-add-<课号>.js`（并在页面 head 引入）：
  `Object.assign(window.CL_GLOSSARY, { "id-kebab": { term, en, cat, short, body, see: [] } });`
- `cat` 只用 `CL_GLOSSARY_CATS` 里的分类。不要改 `glossary-data.js` 本身。

## 6. 写作规范（ASD-STE100 风格的简明中文）

完整规则、中文落地和改写示例：skill 的 `references/asd-ste100-zh.md`。交付前运行 `python3 ~/.claude/skills/interactive-courseware/scripts/ste_lint.py 你的文件.html`，逐条判断并改写。下面是要点：


1. 一句话只说一件事，≤ 25 字为佳。2. 主动语态，主语明确。3. 先结论后理由，每节第一段说清这节讲什么。
4. 术语第一次出现就解释或链接术语表。5. 同一个东西始终用同一个词，沿用原文用词。6. 指令用祈使句。
7. 数字具体，只用原文给出的数字；演示数字标明“模拟”。8. 语气专业平实，不夸张，不堆感叹号。
9. **忠于原文**：观点、例子、数字、限定语（“初步”“原型”“尚未默认开启”）都要讲到；补充放 `.callout.note` 标“补充”。

## 7. 互动演示（课程的核心价值）

- 每课至少 2 个演示，必须**揭示原文的一个机制或权衡**，不是装饰。
- 演示是简化模型：`.chart-foot` 写清假设、与原文数据的关系；不要把模拟结果说成原文结论。
- 数字由页面 JS 现算；正文引用演示结果时写“在这个模拟里”。用 `CL.rng(seed)` 保证可复现。

## 8. 自检（交付前必须做）

```bash
uv run --no-project --with playwright python tools/check_page.py 你的文件.html --shots <scratchpad>
uv run --no-project --with playwright python tools/check_page.py 你的文件.html --theme dark --shots <scratchpad>
uv run --no-project --with playwright python tools/check_page.py 你的文件.html --theme ink --width 1500 --shots <scratchpad>
```
- 只允许“链接到还没写好的其他课程”这类 broken link。
- 打开截图看：演示有内容、文字没溢出/重叠、三个主题都可读。元素截图里压在上面的顶栏是 sticky 造成的假象，不是 bug。
