/* 课程配置：按课程修改。这是课程自己的文件，sync_course.py 不会动它。
 * 框架文件（course-lib.js、course-tutor.js、course.css）各门课相同，用 sync_course.py 升级。
 * 页面里它要排在 course-lib.js 之前（见 AUTHORING.md 第 2 节）。
 */
window.CL = window.CL || {};

CL.CONFIG = {
  prefix: "bm",          // localStorage 键前缀，每门课唯一（file:// 下所有课程共用一个源）
  title: "边牧结构精读",
  seal: "牧",              // 顶栏图章，一个字
  sourceLink: "../docs/articles/tilldone-desk-anatomy.md", // 顶栏“原文”链接，相对课程目录
  port: 8771,                // tools/serve.py 的端口，和 tools/sources.json 的 course.port 一致
  lessonsDir: "lessons", // 课程目录名，离线提示里的命令和地址用它
};

// 学习路线：3–5 步。课程顺序 = 推荐学习顺序（翻页也按这个顺序）
CL.STEPS = [
  { n: 1, name: "全景与双循环", desc: "边牧是什么，Pi 的两层循环怎样决定“停没停”。" },
  { n: 2, name: "两套四层", desc: "扩展四层和桌面四层怎样叠在一起，谁是权威。" },
  { n: 3, name: "上下文管理", desc: "什么进模型的上下文，什么只给界面；两种注入策略。" },
  { n: 4, name: "拆分与分工", desc: "TillDone 原生拆分、PStack 的做法，以及两者怎样咬合、哪里有坑。" },
];
// file 必须和课程文件名一致；src = 对应原文章节
CL.LESSONS = [
  { step: 1, file: "L01-overview.html", id: "L01", title: "边牧全景：羊、边牧与双循环", src: "§0–1" },
  { step: 2, file: "L02-two-four-layers.html", id: "L02", title: "两套四层叠在一起", src: "§2" },
  { step: 3, file: "L03-what-enters-context.html", id: "L03", title: "什么进模型的上下文", src: "§3.1–3.2、§3.4" },
  { step: 3, file: "L04-context-strategies.html", id: "L04", title: "两种注入策略与抗压缩", src: "§3.3、§3.5" },
  { step: 4, file: "L05-tilldone-split.html", id: "L05", title: "TillDone 的原生拆分", src: "§4" },
  { step: 4, file: "L06-pstack-meshing.html", id: "L06", title: "PStack 与 TillDone 的咬合", src: "§5–6" },
  { step: 4, file: "L07-pitfalls-review.html", id: "L07", title: "坑、开放问题与全课复盘", src: "§7–8" },
];
CL.TUTOR_QUICK = [["这一节对应源码的哪个函数？", false]];

// 可选：AI 助教的快捷问题 CL.TUTOR_QUICK / CL.TUTOR_QUICK_BASE，“问 AI”预填问题 CL.TUTOR_ASK_FIG / CL.TUTOR_ASK_DEMO。
// 多课共用的课程自己的函数也写在这里，挂到 CL 上（course-lib.js 会保留它们）。改动会改变演示读数：写进正文和讲稿的数字要重核。
