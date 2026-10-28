---
name: ext-walkthrough
description: 为 pi-vs-claude-code 仓库 extensions/ 下的某个 Pi 扩展生成一篇交互式走读网页 walkthroughs/ 下的 HTML：从四层结构、提示词上下文、业务穿透三个维度讲，每个维度都落到 Pi 的双循环（settle 外循环 / run 内循环）和具体回调点上，配 SVG 图、动画、表格和交互，并登记进走读目录。只要用户想“走读 / 讲解 / 拆解”某个扩展（如 tool-counter.ts、damage-control），说“写下一篇走读”“继续走读”，或者想把某个扩展做成教学网页，就用这个技能，即使用户没提“走读”二字、只报了扩展名。
---

# 扩展走读页

一次调用产出一篇 `walkthroughs/<ext>.html`，并把它登记进目录。读者是正在学 Pi harness 的用户：他已经看过教学课程（`docs/10-pi-harness/teach/lessons/`），想知道每个扩展**挂在 Pi 骨架的哪个位置**。所以每一页的价值在于把扩展代码钉到真实的源码行和循环位置上，而不是复述扩展做了什么。

`walkthroughs/minimal.html` 是第一篇，也是参照样例；`pure-focus.html` 示范了预览状态不是百分比时怎么写。交互机制都在 `walkthroughs/assets/walkthrough.js`，页面只写数据和本扩展专属的函数（见第 4 节）。

## 1. 开工前读

- `extensions/<ext>.ts`，以及它 import 的本地文件（多数会用 `themeMap.ts`）。
- `walkthroughs/minimal.html`、`pure-focus.html`：看结构和数据怎么写。
- `walkthroughs/index.html`：目录顺序决定编号和“下一篇”。用户只说“下一篇”时，取第一个 `ext todo`；用户点名某个扩展时，编号仍按它在目录里的位置。顺序按三维复杂度排（① 回调种类、② 动态提示词 / 上下文装配、③ 注册内容），规则写在目录页“排序依据”一节。新增扩展时按同样规则算分插入，不要按写作先后排。
- 点名的扩展前面还有没写的篇章时，本篇用到的回调如果是第一次在走读里出现，就在本篇讲清楚，不要写“见第 N 篇”。
- `references/source-anchors.md`：Pi 源码锚点行号（1.4.0）。
- 需要核对概念时，读 `../../../../docs/10-pi-harness/teach/lessons/0002-harness-dual-loops.html`（路径相对仓库根）。

Pi 源码一律引用 `LearnTopEngSkills/vendor/pi` 的 TS 源码，因为页面会链到具体行，读者点开就能看到；`/opt/homebrew/...` 下 dist 的 .js 行号读者没法点，版本也可能不同。

## 2. 术语

页面要和教学课程说同一种话，不然读者会以为是两套概念：

- **双循环** = `settle 外循环 · 续跑—停稳`（重复 run，`agent-session.ts` 的 `_startRun`）+ `run 内循环 · 模型—工具`（重复 turn，`agent-loop.ts` 的 `runLoop`）。
- `runLoop` 里有两个嵌套的 `while`，但它们转的都是 turn。如果把外面那个 while 叫成“外循环”，会和 settle 外循环混淆，这正是第一版走读犯过的错。run 内部自己会吸收 steering 和 follow-up；只有 retry、compaction、`agent_end` 之后才排进来的消息、或者 `agent_before_settle` 要求 continue，外循环才会再起一个 run。
- `agent_end` 表示一趟 run 结束；`agent_settled` 才表示本次执行停稳，而且停稳不等于业务成功。
- 四层：`L1 Runtime`（双循环 / 会话 / LLM）、`L2 扩展`（loader / runner / ctx / 事件桥）、`L3 业务`（扩展自己的逻辑）、`L4 UI`（TUI 渲染与输入）。
- 提示词上下文按“安装 / 控制 / 装配”三段讲；消息有 system / user / custom / assistant / toolResult 五种角色。

## 3. 定位：先列 API，再找调用者

列出扩展用到的每个接口：`pi.on(...)`、`pi.registerTool/Command`、`pi.sendMessage`、`ctx.ui.*`、`ctx.*` 的 getter。然后逐个回答三个问题：

1. **谁调用它？** 到源码里 grep，找到发出事件或调用回调的那一行。
2. **在哪一层循环？** 循环外 / settle 外循环 / run 内循环 / 与循环异步（比如 TUI 每帧的 `render`）。
3. **每次 settle 触发几次？**

这张表是整页的骨架，三个维度都从它展开。有些说法只是推断、源码里看不到直接证据时，在页面里写明“推断”。

## 4. 页面结构

从 `assets/template.html` 复制出 `walkthroughs/<ext>.html`。页面里只写 `<main>` 和底部一段 `<script>`：

- 外壳由 `walkthroughs/assets/shell.js` 生成：顶栏、左目录、右本页目录，主题有系统 / 浅色 / 深色三档，不做打印。右侧目录直接取 `h2[id]` 的文字，所以 h2 里只放纯文字，不要嵌 span。
- 源码面板、双循环图和动画、四层步进由 `walkthroughs/assets/walkthrough.js` 生成（API 见 4.1）。18 篇共用一份机制，修一个 bug 不用改 18 个文件，新页也不会抄漏一行。

固定六节，每节都要回答“挂在哪层循环、哪个回调点”：

| 节 | 内容 | 交互 |
|---|---|---|
| 源码 | 只收关键行，逐行标层 `l2/l3/l4/hit` | 点一行，下方显示解释 |
| 双循环与回调点 | `WT.loops` 生成双循环 SVG，本扩展订阅的节点标 `hit`；再配一张回调对照表 | 播放 / 单步 / 重置，事件日志，以及本扩展效果的实时预览 |
| ① 四层结构 | 四层带状 SVG 和 chips，标出启动链和运行链 | 用“下一步”沿链移动圆点 |
| ② 提示词上下文 | 安装 → 控制 → 装配的流向 SVG（`.flow` 虚线动画），再配一张表 | 悬停 `<title>` |
| ③ 业务穿透 | Feature 表：L3 → L2 → L1 → L4，加一列刷新时机 | 模拟器（见下） |
| 小结 | 两三句讲清模式，再预告下一篇 | — |

双循环图的节点和箭头所有扩展都一样，每篇只声明 `hit`、图例和场景。场景按“这个扩展在一次 settle 里会被叫到哪几次”来设计，让读者亲眼看到回调在哪一步亮起。每篇自己定义状态对象（minimal 是 `{ pct }`，pure-focus 是页脚归属、Working、token 等）和预览函数，共用代码不认识任何具体状态，所以别为了套用上一篇的状态去扭曲场景。

图里的节点是**阶段**，不是每个事件都有自己的节点。比如 `tool_execution_end` 没有单独的节点，它属于 `tools` 阶段。这种情况下把 `hit` 标在所属阶段上，再用 `sub` 把那个节点的副标题改成真正订阅的事件名（例如 `{ tools: 'tool_execution_end' }`），图例里也写明。只标 hit 不改副标题，读者会以为扩展订阅的是节点上原来写的那个事件。

回调对照表“每次 settle 触发几次”一列统一用这几个符号：`N` = run 数，`M` = turn 数，`K` = 工具调用数，固定次数直接写数字。

### 4.1 walkthrough.js API

在 `<head>` 里紧跟 `shell.js` 用普通 `<script src="assets/walkthrough.js">` 加载。它加载时只定义全局 `WT`，不碰 DOM；页面在 `</main>` 之后的内联 `<script>` 里调用，那时挂载点都已存在。挂载点的 id 是固定的（template 里都写好了），缺了会直接抛错说缺哪个。数据写错（节点名、chip key 拼错，补丁不是对象）也会在加载时抛错，打开 console 就能看到，不会默默画错。

**`WT.source(SRC)`** → `#src-lines`、`#src-explain`
- `SRC`：`[行号, 代码, 层, 解释 HTML]`。层是 `'l1'|'l2'|'l3'|'l4'|'hit'`。

**`WT.loops(opts)`** → `#loops-fig`（空 div，SVG 生成进去）、`#scn`、`#play`、`#step`、`#reset`、`#ctr`、`#log1`

| 字段 | 含义 |
|---|---|
| `hit` | 本扩展订阅的节点 key 数组，画橙框。节点 key：`session input bas settled astart tstart llm msg tools tend aend post settle` |
| `sub` | 可省。`{ 节点 key: 副标题 }`，覆盖默认副标题（如 pure-focus 把 session 改成“启动 / reload · 循环外”） |
| `legend` | 图下方的图例，纯文本；一行放不下时传两个字符串的数组（最多两行）。写清“橙框 = 本扩展用到的回调”，以及不在图里的回调（`render()`、`registerTool` 等） |
| `scenes` | `{ key: [步骤…] }`，key 对应 `<option value>`。步骤：`[节点, 事件文字, 'outer'\|'inner'\|'', 状态补丁, 说明, run+, turn+]`；补丁没变化写 `{}`，run+/turn+ 写 1 表示计数加一（run+ 会把 turn 归零） |
| `state()` | 返回初始状态对象。每次重置调一次，每步先 `Object.assign(状态, 补丁)` |
| `onStep(st, s)` | 可省。合并补丁之后、预览之前，做补丁表达不了的更新（例如 pure-focus 累加 render 次数） |
| `preview(st, s)` | 每步调用，按状态画预览区。`s = { node, event, loop, patch, note, index }`；想知道“这一步改没改 pct”用 `'pct' in s.patch`。要闪一下就调 `WT.flash(el)` |
| `idle()` | 重置时调用，把预览区恢复成“还没启动” |
| `logTag(s)` | 可省。返回这一步日志行前的 tag HTML（如 `<span class="tag hit">本扩展</span>`）；返回假值就用默认的 外 / 内 / 外部 |
| `interval` | 可省，播放间隔，默认 1100ms |

**`WT.layers({ chips, boot, start })`** → 四层 SVG 里的 `#chips`、`#bootpath`、`#dot2`，以及 `#b-prev`、`#b-next`、`#b-ctr`、`#b-text`
- `chips`：`{ key: [文字, x, 宽, 层中心 y, 是否用到 1|0] }`；层中心 y：L4=51、L3=147、L2=243、L1=339。没用到的 chip 文字是灰的。
- `boot`：`[[chip key, 说明 HTML], …]`，按顺序连成虚线路径；同一个 chip 可以出现多次。
- `start`：可省，第 0 步圆点位置，默认 `[165, 339]`。

最小例子：

```js
WT.source([[14, '  pi.on("session_start", async (_e, ctx) => {', 'hit', '唯一的订阅。']]);
const out = document.getElementById('foot1');
WT.loops({
  hit: ['session'], legend: '橙框 = demo 用到的回调。',
  scenes: { normal: [['session', 'session_start', '', { n: 1 }, '装上'], ['astart', 'agent_start', 'outer', {}, 'run #1', 1]] },
  state: () => ({ n: 0 }),
  preview(st) { out.textContent = `n = ${st.n}`; WT.flash(out); },
  idle() { out.textContent = '（还没启动）'; },
});
WT.layers({ chips: { sess: ['AgentSession', 165, 110, 339, 1] }, boot: [['sess', '创建会话']] });
```

为什么双循环 SVG 由 JS 生成、四层 SVG 和提示词上下文 SVG 留在页面：双循环图 18 篇完全相同，而且动画里圆点的坐标必须和节点坐标对上，放在一处生成就不会抄漏或对不上；另外两张图每篇的 chip 和箭头都不同，本来就是数据（四层的 chip 已经是 `CHIPS`），带状底图很短，留在页面里改起来更直观。

**模拟器**的目的是让读者亲手改输入、看扩展的反应。核心逻辑有内容时，就用 JS 原样复刻它。核心逻辑太薄时（比如 `render() { return []; }`），复刻它没什么可看，这时去模拟它和周围的**互动**：几个扩展叠加时谁说了算，装它和不装它（对照内置行为）有什么区别。pure-focus 那篇就是这样做的。

**扩展很薄时**（没订阅循环事件，或者不碰提示词），照样保留这一节，但内容改成说清它**为什么不在那里**、它影响的是哪一段。例如 minimal 不写提示词，就讲它的进度条读的是装配出来的哪一段。“不在那里”本身就是在给扩展定位，比空着或者硬凑内容更有用。

## 5. 写作

- 简洁：一段最多三四句；能用图或表讲清的，就不写段落。读者是来看定位的，长段落会把关键行号埋掉。
- 讲法上把扩展当作骨架上的一个挂件：先说它挂在哪、谁来叫它，再说它做什么。
- 发现问题时先分清是哪一类，处理方式不同：
  - **扩展代码的 bug**（比如越界、注释和实现不符、路径写错）：写进 `.callout.warn`，最好能在模拟器里复现，附上修法。
  - **叠加使用时的问题**（比如和别的扩展抢同一个槽位）：也写进页面，但要说明不是扩展本身写错了。
  - **设计取舍 / 语义说明**（比如被拦截的工具调用也计数，这算是有意为之还是疏忽，说不准）：用普通的 `.callout`，不用 `.warn`。红框是在告诉读者“这里坏了”，用在说不准的地方语气太重。
  - **当前工作区的临时状态**（比如某个文件被删了、有未提交的改动）：**不写进页面**，只在汇报里告诉用户。页面是长期保留的教学材料，而工作区状态明天就可能变；文件也可能是用户有意删的。
- 不要改 `extensions/` 下的源码：走读是观察，要改代码得另外问用户。
- 源码里看不到直接证据的结论（比如“按 -e 顺序执行”），在页面上标“推断”。判断标准：你亲眼看到了**做这件事的那一行**（而不只是调用链的上游），才算有证据。读者会把页面上的话当成事实，标出来可以免得误导。
- 模拟器只是近似复刻时（比如折行规则简化了），在模拟器下方用一句话写明哪里近似。读者会把模拟器的输出当成真实行为。
- 样式只用 `walkthrough.css` 已有的 token 和类（`--l1..--l4`、`--outer/--inner`、`--hit`、`.tag.*`、`.fig`、`.controls`、`.term`、`.log`、`.src`）。需要新组件就加进 css，这样 18 篇的风格才能保持一致。颜色由数据决定时（比如每种工具一个颜色），可以用 inline style，这不违反规则，因为它不是一种新样式。机制同理：几篇都要的新交互加进 `walkthrough.js`，不要在页面里复制。
- 源码链接都写成完整的 `href="../../../../../vendor/pi/packages/...#L行号"` 字面量，HTML 和 JS 字符串里都可以，但不要用辅助函数拼接。`check.py` 只认字面量，拼出来的链接它校验不到（pure-focus 第一版用了 `L()` 辅助函数，20 条链接因此漏检）。
- SVG 文字的字号用 `font-size` 属性，等宽字体用 `class="mono"`。chip 宽度按字数估算：ASCII 约 6.2px/字，中文约 10.5px/字。估算比截图后再返工省事。

## 6. 登记

- `walkthroughs/assets/shell.js`：在 `WALK.walks` 里追加 `{ n: "NN", title: "<ext>.ts", href: "<ext>.html" }`，左侧目录才会出现这一篇。
- `walkthroughs/index.html`：把这一项从 `div.ext.todo` 改成 `a.ext`，状态写“已完成”，描述换成一句话的特点。
- 上一篇小结里的“下一篇”要和 index 的顺序对得上。

## 7. 验证

```bash
python3 -I .claude/skills/ext-walkthrough/scripts/check.py walkthroughs/<ext>.html
```

脚本检查：标签配对、h2 都有 id、内联 JS 语法、没有残留 dist 的 `.js` 行号、源码链接的文件存在且行号不越界。它不检查外部的 `walkthrough.js`；改过那个文件就再跑 `node --check walkthroughs/assets/walkthrough.js`，并把已有各篇在浏览器里过一遍。行号不越界不代表指对了符号。上次试跑时，人工抽查又找出 2 处指错的行，所以这一步不能省。把页面里每个“回调对照表”和“锚点”用到的链接逐条核对：

```bash
sed -n '<行号>p' /Users/szou/Python/Playground/LearnTopEngSkills/vendor/pi/packages/<路径>   # 这一行应当就是页面上说的那个符号
```

然后在浏览器里看。Chrome 扩展打不开 `file://`，源码的相对链接也要从 `LearnTopEngSkills` 根目录访问才能点通，所以从根目录起服务器：

```bash
cd /Users/szou/Python/Playground/LearnTopEngSkills && python3 -m http.server 8765 --bind 127.0.0.1   # 后台运行；8765 被占用就换一个端口
# http://127.0.0.1:8765/practice/harness-dual-loops/vendor/pi-vs-claude-code/walkthroughs/<ext>.html
```

检查清单：浅色和深色各看一遍；动画从头播到尾；四层步进走完；模拟器试一下边界值；console 没有报错；chip 和节点文字没有溢出。看完把主题切回“系统”（这个设置和教学课程共用），关掉自己开的标签页，只停掉自己起的服务器。可能有别的会话也在用浏览器或别的端口，不要动它们。

## 8. 汇报

用中文告诉用户：页面路径；本扩展订阅了哪些回调、各自挂在哪层循环；发现的问题，按上面三类分别说，工作区状态只在这里讲；验证结果，没跑的步骤要直说。不要自动 commit。
