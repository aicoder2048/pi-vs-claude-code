/* 课程配置：按课程修改。这是课程自己的文件，sync_course.py 不会动它。
 * 框架文件（course-lib.js、course-tutor.js、course.css）各门课相同，用 sync_course.py 升级。
 * 页面里它要排在 course-lib.js 之前（见 AUTHORING.md 第 2 节）。
 */
window.CL = window.CL || {};

CL.CONFIG = {
  prefix: "fl",          // localStorage 键前缀，每门课唯一（file:// 下所有课程共用一个源）
  title: "弈境结构精读",
  seal: "弈",              // 顶栏图章，一个字
  sourceLink: "../docs/articles/five-llm-whitepaper.md", // 顶栏“原文”链接，相对课程目录
  port: 8772,                // tools/serve.py 的端口，和 tools/sources.json 的 course.port 一致
  lessonsDir: "lessons", // 课程目录名，离线提示里的命令和地址用它
};

// 学习路线：3–5 步。课程顺序 = 推荐学习顺序（翻页也按这个顺序）
CL.STEPS = [
  { n: 1, name: "问题与全景", desc: "为什么让 LLM 真落子；四层怎样分，一手棋怎样走完。" },
  { n: 2, name: "循环工程", desc: "Pi SDK 怎样接入；每手一次 settle；接入点与三道闸。" },
  { n: 3, name: "业务层与上下文", desc: "知识包与路由、信号契约、上下文重建、连续冲四搜索。" },
  { n: 4, name: "证据、界面与复盘", desc: "决策证据、Electron 桌面层、pstack 血统与改进方向。" },
];
// file 必须和课程文件名一致；src = 对应原文章节
CL.LESSONS = [
  { step: 1, file: "L01-overview.html", id: "L01", title: "弈境全景：让 LLM 真的落子", src: "§1–2.4" },
  { step: 1, file: "L02-ports-invariants.html", id: "L02", title: "端口、单写者与 revision", src: "§2.3–2.5" },
  { step: 2, file: "L03-sdk-vs-rpc.html", id: "L03", title: "Pi SDK 接入：每手一个 Session", src: "§5.2、§6.2" },
  { step: 2, file: "L04-loop-hooks.html", id: "L04", title: "双循环接入点：提交即停", src: "§3.1–3.5" },
  { step: 2, file: "L05-gates-unused.html", id: "L05", title: "三道闸与刻意不用的回调", src: "§3.6–3.7" },
  { step: 3, file: "L06-knowledge-routing.html", id: "L06", title: "知识包、两级路由与信号契约", src: "§4.1–4.4" },
  { step: 3, file: "L07-context-rebuild.html", id: "L07", title: "上下文工程：用重建取代压缩", src: "§6" },
  { step: 3, file: "L08-forcing-search.html", id: "L08", title: "连续冲四：反证、强杀与提交前反馈", src: "L3 v2/v3" },
  { step: 4, file: "L09-evidence-desktop.html", id: "L09", title: "决策证据与桌面层", src: "§4.5、§5、v2/v3" },
  { step: 4, file: "L10-lineage-review.html", id: "L10", title: "pstack 血统、实战复盘与改进", src: "§4.6–4.8、§7–8" },
];

// 可选：AI 助教的快捷问题 CL.TUTOR_QUICK / CL.TUTOR_QUICK_BASE，“问 AI”预填问题 CL.TUTOR_ASK_FIG / CL.TUTOR_ASK_DEMO。
// 多课共用的课程自己的函数也写在这里，挂到 CL 上（course-lib.js 会保留它们）。改动会改变演示读数：写进正文和讲稿的数字要重核。
