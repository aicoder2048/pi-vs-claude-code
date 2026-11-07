/* AI 讲师注入到课程页的部分：控制条、快捷键、段落高亮、音频播放。
 * 由 stage.py 通过 add_init_script 注入；按键通过 window.__lecturerCmd 回传给 Python。
 */
(function () {
  "use strict";
  if (window.__lecturer) return;

  const css = `
  /* 只画外框，不动元素自己的背景和圆角：深色底的 hero 等元素换了背景，浅色文字就看不见了 */
  .lecturer-focus { outline: 3px solid #e8a33d; outline-offset: 6px; transition: outline-color .3s; }
  .lecturer-bar { position: fixed; left: 20px; bottom: 20px; z-index: 9999; display: flex; gap: 6px; align-items: center;
    padding: 8px 10px; border-radius: 12px; background: rgba(28,32,40,.92); color: #fff;
    font: 13px/1.4 -apple-system, "PingFang SC", sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.25); }
  .lecturer-bar button { all: unset; cursor: pointer; padding: 5px 9px; border-radius: 8px; background: rgba(255,255,255,.1); }
  .lecturer-bar button:hover { background: rgba(255,255,255,.22); }
  .lecturer-bar button[disabled] { opacity: .35; cursor: default; }
  .lecturer-bar .who { min-width: 13em; max-width: 26em; padding: 0 6px; opacity: .9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lecturer-bar .who b { color: #f5c26b; font-weight: 600; }
  .lecturer-bar kbd { font: 11px ui-monospace, monospace; opacity: .6; margin-left: 3px; }
  .lecturer-bar.reading { background: rgba(24,52,64,.94); }
  .lecturer-bar.reading .rex { display: none; }
  .lecturer-bar.reading .who { max-width: 28em; }
  /* 右栏每条助教回答底部的重听按钮：放底部，因为读完时长回答的顶部早已滚出视野 */
  .lecturer-replay { display: inline-flex; align-items: center; gap: 4px; margin-top: 10px; padding: 4px 12px;
    border: 1px solid var(--brand, #1f3a5f); border-radius: 999px; background: transparent; color: var(--brand, #1f3a5f);
    font: 600 13px/1.4 -apple-system, "PingFang SC", sans-serif; cursor: pointer; }
  .lecturer-replay:hover { background: var(--brand, #1f3a5f); color: var(--surface, #fff); }`;

  const audio = new Audio();
  let ended = null; // 当前这段音频播完时调用

  function finish() { const f = ended; ended = null; if (f) f(); }
  audio.addEventListener("ended", finish);
  audio.addEventListener("error", finish);

  // 第二路音频：朗读学生自己提问的助教回答，不打扰暂停中的讲师音频
  const aside = new Audio();
  let asideEnded = null;
  function finishAside() { const f = asideEnded; asideEnded = null; if (f) f(); }
  aside.addEventListener("ended", finishAside);
  aside.addEventListener("error", finishAside);

  // play() 刚开始加载就被 pause() 打断时，浏览器以 AbortError 拒绝它——那不是“播完了”，
  // 等 resume 再接着播；别的错误（文件坏了、不让自动播放）才当作这段结束，免得讲课卡住。
  const endUnlessPaused = (end) => (e) => { if (!e || e.name !== "AbortError") end(); };

  function send(cmd) { if (window.__lecturerCmd) window.__lecturerCmd(cmd); }

  function mount() {
    if (document.querySelector(".lecturer-bar")) return;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    const bar = document.createElement("div");
    bar.className = "lecturer-bar";
    bar.innerHTML =
      '<button data-cmd="prev" title="上一步（←）">⏮</button>' +
      '<button data-cmd="toggle" class="tog" title="暂停/继续（空格）">⏸</button>' +
      '<button data-cmd="next" title="下一步（→）">⏭</button>' +
      '<button data-cmd="reexplain" class="rex" title="没听懂，换个讲法（R）">换个讲法<kbd>R</kbd></button>' +
      '<span class="who">讲师准备中…</span>';
    bar.addEventListener("click", (e) => { const b = e.target.closest("button[data-cmd]"); if (b && !b.disabled) send(b.dataset.cmd); });
    document.body.appendChild(bar);
  }

  // 插播助教朗读时，⏮/⏭ 换成“从头读 / 跳过”
  const LABELS = {
    lecture: { prev: ["⏮", "上一步（←）"], next: ["⏭", "下一步（→）"], tog: "暂停/继续（空格）" },
    reading: { prev: ["↺", "这条回答从头再读（←）"], next: ["⏭ 跳过", "跳过朗读，回到讲师（→ 或 Esc）"], tog: "暂停/继续朗读（空格）" },
  };
  function setMode(bar, reading) {
    const L = LABELS[reading ? "reading" : "lecture"];
    bar.classList.toggle("reading", reading);
    for (const k of ["prev", "next"]) {
      const b = bar.querySelector('[data-cmd="' + k + '"]');
      b.textContent = L[k][0]; b.title = L[k][1];
    }
    bar.querySelector(".tog").title = L.tog;
  }

  // 🔊 重听：给右栏每条已经答完的助教回答加一个按钮（右栏会整块重绘，所以用 MutationObserver 补上）
  function answers() { return [...document.querySelectorAll(".tutor-panel .tp-msg.ai")]; }
  function speakable(m) {
    if (m.querySelector(".tp-caret, .tp-dots")) return false;
    const c = m.cloneNode(true);
    c.querySelectorAll(".tp-err, .tp-tools, .tp-errata, .lecturer-replay, pre, table, svg").forEach((x) => x.remove());
    return c.innerText.trim().length > 0;
  }
  function addReplayButtons() {
    for (const m of answers()) {
      if (m.querySelector(":scope > .lecturer-replay") || !speakable(m)) continue;
      const b = document.createElement("button");
      b.type = "button"; b.className = "lecturer-replay"; b.textContent = "🔊 朗读这条"; b.title = "让助教把这条回答读一遍";
      m.append(b);
    }
  }
  let queued = false;
  function watchAnswers() {   // 注入时页面还没有 DOM，等 DOMContentLoaded 再开始看
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; addReplayButtons(); });
    }).observe(document.body, { childList: true, subtree: true });
    addReplayButtons();
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".lecturer-replay"); if (!b) return;
    e.preventDefault(); e.stopPropagation();   // 记笔记的勾选模式里，点它不算选中这条
    send("replay:" + answers().indexOf(b.closest(".tp-msg.ai")));
    b.blur();
  }, true);

  function typing(t) {
    return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  }
  document.addEventListener("keydown", (e) => {
    if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (typing(e.target)) {
      // Esc：离开输入框；正在朗读助教时顺便跳过朗读（不在朗读时 Python 那边会忽略）
      if (e.key === "Escape") { e.target.blur(); e.preventDefault(); send("stop"); }
      return; // 输入框里打字时快捷键不生效
    }
    const cmd = { " ": "toggle", Escape: "stop", ArrowRight: "next", ArrowLeft: "prev", r: "reexplain", R: "reexplain" }[e.key];
    if (!cmd) return;
    if (cmd === "stop") { send(cmd); return; } // Esc 不拦截：页面还要用它关放大图
    e.preventDefault(); e.stopPropagation();
    const b = document.querySelector('.lecturer-bar button[data-cmd="' + cmd + '"]');
    if (!b || !b.disabled) send(cmd);
  }, true);

  window.__lecturer = {
    /* 播放一段音频，播完（或被 stop）时 Promise 才返回 */
    play(url) {
      finish();
      return new Promise((resolve) => {
        ended = resolve;
        audio.src = url;
        audio.play().catch(endUnlessPaused(finish));
      });
    },
    pause() { audio.pause(); },
    resume() { if (ended) audio.play().catch(endUnlessPaused(finish)); },
    stop() { audio.pause(); finish(); },
    playAside(url) {
      finishAside();
      return new Promise((resolve) => {
        asideEnded = resolve;
        aside.src = url;
        aside.play().catch(endUnlessPaused(finishAside));
      });
    },
    pauseAside() { aside.pause(); },
    resumeAside() { if (asideEnded) aside.play().catch(endUnlessPaused(finishAside)); },
    stopAside() { aside.pause(); finishAside(); },
    highlight(sel, nth) {
      document.querySelectorAll(".lecturer-focus").forEach((x) => x.classList.remove("lecturer-focus"));
      const el = document.querySelectorAll(sel)[nth || 0];
      if (!el) return false;
      el.classList.add("lecturer-focus");
      el.scrollIntoView({ behavior: "smooth", block: el.offsetHeight > innerHeight * 0.8 ? "start" : "center" });
      return true;
    },
    status(html, paused, canReexplain, reading) {
      mount();
      const bar = document.querySelector(".lecturer-bar");
      setMode(bar, !!reading);
      bar.querySelector(".who").innerHTML = html;
      bar.querySelector(".tog").textContent = paused ? "▶" : "⏸";
      bar.querySelector(".rex").disabled = !canReexplain;
    },
  };
  function ready() { mount(); watchAnswers(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();
})();
