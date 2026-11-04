/* 边牧结构精读 — 公用脚本（框架移植自 ta-knowhow/LESSONS/assets/ta-lib.js，去掉了行情图表部分）
 * 依赖: assets/glossary-data.js (window.CL_GLOSSARY)
 * 用法见 AUTHORING.md
 */
(function () {
  "use strict";
  const CL = (window.CL = window.CL || {});

  /* ================= 课程目录 (导航/翻页用) ================= */
  /* ===== 课程配置：按课程修改 ===== */
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
  CL.LESSONS.forEach((l, k) => { l.no = k + 1; l.group = "第 " + l.step + " 步 · " + CL.STEPS[l.step - 1].name; });

  /* 已学记录：只存在本机浏览器里，读不到也不影响页面 */
  CL.visited = function () { try { return JSON.parse(localStorage.getItem("bm-visited") || "[]"); } catch (e) { return []; } };
  CL.resetVisited = function () { try { localStorage.removeItem("bm-visited"); } catch (e) { /* ignore */ } };
  CL.resetButton = function (onDone) {
    const b = document.createElement("button"); b.type = "button"; b.className = "reset-visited"; b.textContent = "重置";
    b.title = "清除所有课程的“已学”标记（只影响本机浏览器）";
    let armed = null;
    b.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!armed) { b.textContent = "确定重置？"; b.classList.add("armed"); armed = setTimeout(() => { armed = null; b.textContent = "重置"; b.classList.remove("armed"); }, 3000); return; }
      clearTimeout(armed); armed = null; CL.resetVisited(); onDone();
      b.textContent = "已重置"; b.classList.remove("armed"); setTimeout(() => { b.textContent = "重置"; }, 1500);
    });
    return b;
  };
  function unmarkVisited(file) { try { localStorage.setItem("bm-visited", JSON.stringify(CL.visited().filter((f) => f !== file))); } catch (e) { /* ignore */ } }
  function markVisited(file) { try { const v = CL.visited(); if (!v.includes(file)) { v.push(file); localStorage.setItem("bm-visited", JSON.stringify(v)); } } catch (e) { /* ignore */ } }

  /* ================= 主题：浅色 → 深色 → 水墨 轮换 ================= */
  CL.THEMES = [
    { id: "light", label: "浅色", icon: "☀" },
    { id: "dark", label: "深色", icon: "☾" },
    { id: "ink", label: "水墨", icon: "墨" },
  ];
  function storedTheme() { try { return localStorage.getItem("bm-theme"); } catch (e) { return null; } }
  function saveTheme(t) { try { localStorage.setItem("bm-theme", t); } catch (e) { /* ignore */ } }
  const st = storedTheme();
  if (st && CL.THEMES.some((t) => t.id === st)) document.documentElement.setAttribute("data-theme", st);
  CL.theme = function () {
    const t = document.documentElement.getAttribute("data-theme");
    if (t) return t;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };
  CL.cssVar = function (name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); };
  const themeListeners = [];
  CL.onTheme = function (fn) { themeListeners.push(fn); };   // 演示里用 JS 写死颜色时，主题切换后重画

  /* 固定配色：在三种主题下都可读 */
  CL.C = { blue: "#3d7be8", orange: "#e8a33d", teal: "#16a085", purple: "#9b59b6", red: "#d64541", gray: "#8a94a3", gold: "#c9a227", pink: "#d6458f" };

  /* ================= 小工具 ================= */
  CL.$ = (s, root) => (root || document).querySelector(s);
  CL.$$ = (s, root) => [...(root || document).querySelectorAll(s)];
  CL.fmt = (x, d = 1) => (x == null || isNaN(x) ? "—" : Number(x).toFixed(d));
  CL.esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // 可复现的伪随机数（演示用，同一个 seed 每次结果一样）
  CL.rng = function (seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };
  // 百分位（p 取 0–100）
  CL.pctl = function (arr, p) { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); const k = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1)); return a[k]; };

  /**
   * CL.lanes(el, lanes, opts) — 画一组时间线泳道（纯 HTML，自动适配主题）
   * lanes: [{name, segs:[{t0, t1, cls:"c1".."c6", text}], ticks:[t]}]   opts: {t0=0, t1, unit:"s"}
   */
  CL.lanes = function (el, lanes, opts = {}) {
    if (typeof el === "string") el = document.querySelector(el);
    const t0 = opts.t0 || 0;
    const t1 = opts.t1 || Math.max(1, ...lanes.flatMap((l) => (l.segs || []).map((s) => s.t1)));
    const X = (t) => ((t - t0) / (t1 - t0)) * 100;
    let h = '<div class="lanes">';
    for (const l of lanes) {
      h += '<div class="lane"><div class="ln" title="' + CL.esc(l.name) + '">' + CL.esc(l.name) + '</div><div class="tr">';
      for (const s of l.segs || []) h += '<div class="seg ' + (s.cls || "c1") + '" style="left:' + X(s.t0) + "%;width:" + Math.max(0.6, X(s.t1) - X(s.t0)) + '%" title="' + CL.esc(s.title || s.text || "") + '">' + CL.esc(s.text || "") + "</div>";
      for (const t of l.ticks || []) h += '<div class="tick" style="left:' + X(t) + '%"></div>';
      h += "</div></div>";
    }
    h += '</div><div class="axis">' + [0, 0.25, 0.5, 0.75, 1].map((f) => "<span>" + CL.fmt(t0 + f * (t1 - t0), 0) + (opts.unit || "") + "</span>").join("") + "</div>";
    el.innerHTML = h;
  };

  /* ================= 给 AI 助教的截图 ================= */
  // 返回 Promise<dataURL|null>：卡片里的第一张 <img> 或 <canvas>（同源，经 serve.py 打开时可用）
  CL.snapshot = async function (container) {
    const img = container.querySelector("img");
    const cv = container.querySelector("canvas");
    try {
      if (img) {
        if (!img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
        const scale = Math.min(1, 1400 / (img.naturalWidth || 1));
        const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
        const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL("image/jpeg", 0.85);
      }
      if (cv) return cv.toDataURL("image/jpeg", 0.85);
    } catch (e) { console.warn("[CL] 截图失败", e); }
    return null;
  };

  /* ================= 交互组件 ================= */
  function initQuiz() {
    document.querySelectorAll(".quiz").forEach((q) => {
      const ans = Number(q.dataset.answer);
      q.querySelectorAll(".opts button").forEach((b, i) => b.addEventListener("click", () => {
        if (q.classList.contains("done")) return;
        b.classList.add(i === ans ? "right" : "wrong");
        q.querySelectorAll(".opts button")[ans].classList.add("right");
        q.classList.add("done");
      }));
    });
  }
  function initChecklist() {
    document.querySelectorAll("ul.checklist li").forEach((li) => li.addEventListener("click", () => li.classList.toggle("checked")));
  }
  // 原文配图点击放大
  function initFigZoom() {
    document.querySelectorAll("main .fig img").forEach((img) => img.addEventListener("click", () => {
      const z = document.createElement("div"); z.className = "fig-zoom"; z.innerHTML = '<img alt="">';
      z.firstChild.src = img.src; z.addEventListener("click", () => z.remove());
      document.addEventListener("keydown", function k(e) { if (e.key === "Escape") { z.remove(); document.removeEventListener("keydown", k); } });
      document.body.appendChild(z);
    }));
  }
  // 术语提示: <a class="term" href="glossary.html#router">Router</a>
  function initTerms(root) {
    const G = window.CL_GLOSSARY || {}; let tip = null;
    (root || document).querySelectorAll("a.term:not([data-term-ready])").forEach((a) => {
      a.setAttribute("data-term-ready", "");
      const id = (a.getAttribute("href") || "").split("#")[1] || a.dataset.term;
      const t = G[id];
      if (!t) { a.classList.add("term-missing"); console.warn("[CL] 术语表缺少:", id); return; }
      a.addEventListener("mouseenter", () => {
        tip = document.createElement("div"); tip.className = "term-tip";
        tip.innerHTML = "<b>" + t.term + (t.en ? " · " + t.en : "") + "</b>" + t.short;
        document.body.appendChild(tip);
        const r = a.getBoundingClientRect();
        let left = r.left + window.scrollX; const w = Math.min(340, window.innerWidth - 24);
        if (left + w > window.innerWidth - 12) left = window.innerWidth - w - 12;
        tip.style.left = Math.max(12, left) + "px"; tip.style.top = r.bottom + window.scrollY + 6 + "px";
      });
      a.addEventListener("mouseleave", () => { if (tip) tip.remove(); tip = null; });
    });
  }
  function initToc() {
    const links = [...document.querySelectorAll(".cn-toc a, aside.toc a")]; if (!links.length) return;
    const secs = links.map((a) => document.querySelector(a.getAttribute("href"))).filter(Boolean);
    const onScroll = () => {
      let cur = secs[0];
      for (const s of secs) if (s.getBoundingClientRect().top < 120) cur = s;
      links.forEach((a) => a.classList.toggle("active", cur && a.getAttribute("href") === "#" + cur.id));
    };
    window.addEventListener("scroll", onScroll, { passive: true }); onScroll();
  }

  /* ================= 顶栏 + 学习路线（左栏）+ 面包屑 + 翻页 ================= */
  function themeLabel() {
    const t = CL.THEMES.find((x) => x.id === CL.theme()) || CL.THEMES[0];
    return '<span class="ti">' + t.icon + "</span>" + t.label;
  }
  function navOpenSteps(curStep) {
    let open = null;
    try { open = JSON.parse(localStorage.getItem("bm-nav-open") || "null"); } catch (e) { /* ignore */ }
    if (!Array.isArray(open)) open = [1];
    if (curStep && !open.includes(curStep)) open.push(curStep);
    return open;
  }
  function saveNavOpen(list) { try { localStorage.setItem("bm-nav-open", JSON.stringify(list)); } catch (e) { /* ignore */ } }
  function courseNavHtml(cur, curStep, tocHtml) {
    const v = CL.visited(), done = CL.LESSONS.filter((l) => v.includes(l.file)).length, open = navOpenSteps(curStep);
    let h = '<div class="cn-head"><a class="cn-title" href="index.html">学习路线</a>' +
      '<div class="cn-prog"><span>已学 ' + done + " / " + CL.LESSONS.length + '</span><div class="bar"><i style="width:' + Math.round((100 * done) / CL.LESSONS.length) + '%"></i></div></div></div>';
    for (const st of CL.STEPS) {
      const ls = CL.LESSONS.filter((x) => x.step === st.n), d = ls.filter((l) => v.includes(l.file)).length;
      const isOpen = open.includes(st.n);
      h += '<div class="cn-step' + (isOpen ? " open" : "") + '" data-step="' + st.n + '">' +
        '<button type="button" class="cn-step-h" aria-expanded="' + isOpen + '"><span class="sn">' + st.n + '</span><span class="nm">' + st.name +
        '</span><span class="cnt">' + d + "/" + ls.length + '</span><span class="chev" aria-hidden="true">›</span></button><ol>';
      for (const l of ls) {
        const isCur = l.file === cur;
        const cls = (isCur ? "cur " : "") + (v.includes(l.file) ? "done" : "");
        h += "<li" + (isCur ? ' class="cur-li"' : "") + '><a class="' + cls + '" href="' + l.file + '"' + (isCur ? ' aria-current="page"' : "") + '><span class="no">' + String(l.no).padStart(2, "0") +
          '</span><span class="t">' + l.title + '</span><span class="ck" role="button" tabindex="0" title="点一下：切换这一课的“已学”标记">✓</span></a>' + (isCur && tocHtml ? tocHtml : "") + "</li>";
      }
      h += "</ol></div>";
    }
    return h;
  }
  function initChrome() {
    if (!document.querySelector("link[rel~=icon]")) {
      const ic = document.createElement("link"); ic.rel = "icon"; ic.href = "assets/favicon.svg"; document.head.appendChild(ic);
    }
    const pg = document.getElementById("cl-pager");
    const cur = pg ? pg.dataset.current : location.pathname.split("/").pop();
    const lesson = CL.LESSONS.find((l) => l.file === cur);
    if (lesson) markVisited(lesson.file);
    const layout = document.querySelector(".layout");
    const hasNav = !!(lesson && layout);

    const top = document.getElementById("cl-topbar");
    if (top) {
      top.className = "topbar";
      top.innerHTML = '<div class="topbar-inner">' +
        (hasNav ? '<button class="nav-btn" type="button" aria-label="打开学习路线">☰ 学习路线</button>' : "") +
        '<a class="brand" href="index.html"><span class="seal">牧</span>边牧结构精读<small>互动课程</small></a>' +
        '<nav><a href="index.html">课程目录</a><a href="glossary.html">术语表</a><a href="../docs/articles/tilldone-desk-anatomy.md" title="原文存档">原文</a>' +
        '<button class="theme-btn" type="button" title="切换主题：浅色 → 深色 → 水墨">' + themeLabel() + "</button></nav></div>";
      const tb = top.querySelector(".theme-btn");
      tb.addEventListener("click", () => {
        const k = CL.THEMES.findIndex((x) => x.id === CL.theme());
        const next = CL.THEMES[(k + 1) % CL.THEMES.length].id;
        document.documentElement.setAttribute("data-theme", next); saveTheme(next);
        tb.innerHTML = themeLabel(); themeListeners.forEach((f) => f());
      });
      if (hasNav) top.querySelector(".nav-btn").addEventListener("click", () => document.body.classList.toggle("nav-open"));
    }

    if (hasNav) {
      layout.classList.add("three-col");
      const nav = document.createElement("aside");
      nav.className = "course-nav"; nav.setAttribute("aria-label", "学习路线");
      const toc = layout.querySelector("aside.toc ol");
      const tocHtml = toc ? '<ol class="cn-toc" aria-label="本课小节">' + toc.innerHTML + "</ol>" : "";
      nav.innerHTML = courseNavHtml(cur, lesson.step, tocHtml);
      layout.insertBefore(nav, layout.firstChild);
      const refreshNav = () => {
        const v = CL.visited();
        nav.querySelectorAll(".cn-step").forEach((box) => {
          const as = box.querySelectorAll("ol:not(.cn-toc) > li > a");
          as.forEach((a) => a.classList.toggle("done", v.includes(a.getAttribute("href"))));
          box.querySelector(".cnt").textContent = [...as].filter((a) => a.classList.contains("done")).length + "/" + as.length;
        });
        nav.querySelector(".cn-prog span").textContent = "已学 " + v.length + " / " + CL.LESSONS.length;
        nav.querySelector(".cn-prog .bar i").style.width = Math.round((100 * v.length) / CL.LESSONS.length) + "%";
      };
      nav.querySelector(".cn-prog").appendChild(CL.resetButton(() => { markVisited(cur); refreshNav(); }));
      const toggleOne = (ck) => {
        const f = ck.closest("a").getAttribute("href");
        if (CL.visited().includes(f)) unmarkVisited(f); else markVisited(f);
        refreshNav();
      };
      nav.addEventListener("click", (e) => { const ck = e.target.closest(".ck"); if (!ck) return; e.preventDefault(); e.stopPropagation(); toggleOne(ck); });
      nav.addEventListener("keydown", (e) => { const ck = e.target.closest(".ck"); if (ck && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggleOne(ck); } });
      nav.querySelectorAll(".cn-step-h").forEach((b) => b.addEventListener("click", () => {
        const box = b.parentElement, on = !box.classList.contains("open");
        box.classList.toggle("open", on); b.setAttribute("aria-expanded", on);
        saveNavOpen([...nav.querySelectorAll(".cn-step.open")].map((x) => +x.dataset.step));
      }));
      nav.querySelectorAll(".cn-toc a").forEach((a) => a.addEventListener("click", () => document.body.classList.remove("nav-open")));
      const shade = document.createElement("div"); shade.className = "nav-shade";
      shade.addEventListener("click", () => document.body.classList.remove("nav-open"));
      document.body.appendChild(shade);
      const curA = nav.querySelector("a.cur");
      if (curA) setTimeout(() => { const t = curA.offsetTop - 80; if (t > nav.clientHeight / 2) nav.scrollTop = t; }, 0);
      const hero = document.querySelector("main .hero");
      if (hero) {
        const s = CL.STEPS[lesson.step - 1];
        const bc = document.createElement("nav"); bc.className = "crumbs"; bc.setAttribute("aria-label", "位置");
        bc.innerHTML = '<a href="index.html">课程目录</a><span>›</span><a href="index.html#step-' + s.n + '">第 ' + s.n + " 步 · " + s.name +
          "</a><span>›</span><b>第 " + String(lesson.no).padStart(2, "0") + " / " + CL.LESSONS.length + " 课</b>";
        hero.parentNode.insertBefore(bc, hero);
      }
    }

    if (lesson) { // AI 助教（需要 tools/serve.py 本地服务；file:// 打开时只显示启动说明）
      const sc = document.createElement("script"); sc.src = "assets/course-tutor.js"; document.body.appendChild(sc);
    }
    if (pg) {
      const i = CL.LESSONS.findIndex((l) => l.file === cur);
      const prev = CL.LESSONS[i - 1], next = CL.LESSONS[i + 1];
      pg.className = "pager";
      pg.innerHTML = (prev ? '<a href="' + prev.file + '"><small>← 上一课 · ' + prev.id + "</small>" + prev.title + "</a>" : "<span></span>") +
        (next ? '<a class="next" href="' + next.file + '"><small>下一课 · ' + next.id + " →</small>" + next.title + "</a>" : "<span></span>");
    }
    if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => themeListeners.forEach((f) => f()));
  }
  CL.initTerms = initTerms;
  CL.onReady = function (fn) { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn); else fn(); };
  CL.onReady(() => { initChrome(); initQuiz(); initChecklist(); initTerms(); initToc(); initFigZoom(); });
})();
