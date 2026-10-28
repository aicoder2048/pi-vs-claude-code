// 走读页共用外壳，仿 docs/10-pi-harness/teach/assets/shell.js。
// 在 <head> 里同步加载（不加 defer），让保存的主题在首帧前生效。
// 页面只写 <main>…</main>；本脚本补上顶栏、左侧走读目录（来自下面的 WALK）和右侧本页目录（来自页面的 <h2 id>）。
// 每写完一篇，在 WALK.walks 里加一行。
(function () {
  const LESSONS = "../../../../../docs/10-pi-harness/teach/lessons/";
  const WALK = {
    title: "Pi 扩展走读",
    edition: "Pi v1.4.0",
    home: "index.html",
    // 阅读指南：跨篇通用的读法，会持续增补。新加一篇指南就在这里加一行。
    guides: [
      { title: "怎么读双循环与回调点", href: "guide-loops.html" },
    ],
    walks: [
      { n: "01", title: "minimal.ts", href: "minimal.html" },
      { n: "02", title: "pure-focus.ts", href: "pure-focus.html" },
      { n: "03", title: "tool-counter-widget.ts", href: "tool-counter-widget.html" },
      { n: "04", title: "tool-counter.ts", href: "tool-counter.html" },
      { n: "05", title: "damage-control.ts", href: "damage-control.html" },
      { n: "06", title: "damage-control-continue.ts", href: "damage-control-continue.html" },
      { n: "07", title: "session-replay.ts", href: "session-replay.html" },
      { n: "08", title: "cross-agent.ts", href: "cross-agent.html" },
      { n: "09", title: "theme-cycler.ts", href: "theme-cycler.html" },
      { n: "10", title: "system-select.ts", href: "system-select.html" },
      { n: "11", title: "purpose-gate.ts", href: "purpose-gate.html" },
      { n: "12", title: "tilldone.ts", href: "tilldone.html" },
      { n: "13", title: "agent-team.ts", href: "agent-team.html" },
      { n: "14", title: "agent-chain.ts", href: "agent-chain.html" },
      { n: "15", title: "pi-pi.ts", href: "pi-pi.html" },
      { n: "16", title: "subagent-widget.ts", href: "subagent-widget.html" },
      { n: "17", title: "coms.ts", href: "coms.html" },
      { n: "18", title: "coms-net.ts", href: "coms-net.html" },
    ],
    lessons: [
      { n: "01", title: "循环骨架与插口", href: LESSONS + "0001-loop-skeleton-and-sockets.html" },
      { n: "02", title: "Harness 双循环与 16 项接口", href: LESSONS + "0002-harness-dual-loops.html" },
      { n: "03", title: "上下文工程与消息流", href: LESSONS + "0003-context-engineering-and-message-flow.html" },
      { n: "04", title: "Pi 与 Claude Code 宏观结构", href: LESSONS + "0004-harness-macro-structure.html" },
    ],
  };
  const THEMES = [["system", "系统"], ["light", "浅色"], ["dark", "深色"]];
  const KEY = "pi-teach-theme"; // 与教学课程共用，切一次两边一致

  const root = document.documentElement;
  const readTheme = () => { try { return localStorage.getItem(KEY) || "system"; } catch (e) { return "system"; } };
  const applyTheme = (t) => { if (t === "system") delete root.dataset.theme; else root.dataset.theme = t; };
  applyTheme(readTheme());

  // shell.js 在 walkthroughs/assets/ 下，所以走读根目录是上一级。
  const base = new URL("..", document.currentScript.src);
  const here = location.href.split("#")[0].split("?")[0];

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    n.append(...kids);
    return n;
  };
  const link = (item, label) => {
    const href = new URL(item.href, base).href;
    const a = el("a", { href }, ...label);
    if (href === here) a.setAttribute("aria-current", "page");
    return a;
  };
  const list = (items) => el("ol", {}, ...items.map((x) => el("li", {}, link(x, x.n ? [el("span", { class: "num" }, x.n), x.title] : [x.title]))));

  document.addEventListener("DOMContentLoaded", () => {
    const main = document.querySelector("main");
    if (!main) return;
    main.id ||= "main-content";

    // 顶栏：品牌 + 版本 + 主题切换
    const sw = el("div", { class: "theme-switch", role: "group", "aria-label": "页面主题" });
    const buttons = THEMES.map(([id, label]) => {
      const b = el("button", { type: "button", "data-theme-choice": id }, label);
      b.addEventListener("click", () => {
        applyTheme(id);
        try { localStorage.setItem(KEY, id); } catch (e) {}
        sync();
      });
      sw.append(b);
      return b;
    });
    const sync = () => buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeChoice === readTheme())));
    sync();
    const topbar = el("header", { class: "topbar" },
      el("a", { class: "brand", href: new URL(WALK.home, base).href }, WALK.title),
      el("div", { class: "tools" }, el("span", { class: "edition" }, WALK.edition), sw));

    // 左：走读目录 + 参考课程
    const left = el("aside", { class: "course-nav" },
      el("details", { open: "" }, el("summary", {}, "走读目录"),
        el("nav", { "aria-label": "走读目录" },
          el("h2", {}, "总览"), list([{ title: "目录与阅读方法", href: WALK.home }]),
          el("h2", {}, "阅读指南"), list(WALK.guides),
          el("h2", {}, "走读"), list(WALK.walks),
          el("h2", {}, "参考课程"), list(WALK.lessons))));

    // 右：本页目录（取 main 里的 h2[id]）
    const heads = [...main.querySelectorAll("h2[id]")];
    const index = el("nav", { class: "section-index", "aria-label": "本页目录" },
      ...heads.map((h) => el("a", { href: "#" + h.id }, h.textContent.replace(/^\d+\.\s*/, ""))));
    const right = el("aside", { class: "section-nav" },
      el("details", { open: "" }, el("summary", {}, "本页目录"), el("h2", {}, "本页目录"), index));

    const grid = el("div", { class: "reader-grid" });
    main.replaceWith(grid);
    grid.append(left, main, right);
    document.body.prepend(el("a", { class: "skip-link", href: "#" + main.id }, "跳至正文"), topbar);

    // 高亮正在读的小节
    const links = new Map([...index.querySelectorAll("a")].map((a) => [a.getAttribute("href").slice(1), a]));
    const spy = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        links.forEach((a) => a.removeAttribute("aria-current"));
        links.get(e.target.id)?.setAttribute("aria-current", "location");
      }
    }, { rootMargin: "-90px 0px -70% 0px" });
    heads.forEach((h) => spy.observe(h));
  });
})();
