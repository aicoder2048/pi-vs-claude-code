/* AI 助教：课程页右侧的对话面板（DeepSeek，经本地 tools/serve.py 转发）
 * 由 course-lib.js 在课程页自动加载。上下文 = 原文 + 本课全文 + 正在看的小节 + 选中的文字 + 配图/演示截图和读数。
 */
(function () {
  "use strict";
  const CL = window.CL;
  const pg = document.getElementById("cl-pager");
  const LESSON = pg ? pg.dataset.current : location.pathname.split("/").pop();
  const lesson = CL.LESSONS.find((l) => l.file === LESSON);
  if (!lesson) return;
  const STORE = "bm-tutor:" + LESSON;
  const isHttp = location.protocol === "http:" || location.protocol === "https:";

  /* ---------- 状态 ---------- */
  let history = load();              // [{role, content, meta?}]
  let pending = null;                // {chartCard, selection} 附在下一条提问上
  let busy = false, ctrl = null, serverOk = null, model = "deepseek-flash";

  // 面板默认常开；用户手动收起后记住（所有课程共用这个偏好）
  function panelPref() { try { return localStorage.getItem("bm-tutor-panel"); } catch (e) { return null; } }
  function savePanelPref(v) { try { localStorage.setItem("bm-tutor-panel", v); } catch (e) { /* ignore */ } }
  function load() { try { return JSON.parse(localStorage.getItem(STORE) || "[]"); } catch (e) { return []; } }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(history.slice(-40))); } catch (e) { /* ignore */ } }

  /* ---------- DOM ---------- */
  const fab = el("button", "tutor-fab", '<span class="seal">问</span>AI 助教');
  fab.type = "button"; fab.title = "向 AI 助教提问（带着本课上下文）";
  const panel = el("aside", "tutor-panel");
  panel.setAttribute("aria-label", "AI 助教");
  panel.innerHTML =
    '<div class="tp-head"><div><b>AI 助教</b><small class="tp-model"></small></div>' +
    '<div class="tp-tools"><button type="button" class="tp-clear" title="清空本课对话">清空</button><button type="button" class="tp-close" title="收起 AI 助教（右下角可重新打开）">收起 ›</button></div></div>' +
    '<div class="tp-where"></div>' +
    '<div class="tp-msgs" aria-live="polite"></div>' +
    '<div class="tp-quick"></div>' +
    '<div class="tp-attach"></div>' +
    '<form class="tp-form"><textarea rows="3" placeholder="问任何关于本课的问题……  Enter 发送，Shift+Enter 换行"></textarea>' +
    '<div class="tp-row"><label class="tp-chk"><input type="checkbox" class="tp-img"> 附上当前小节的图表截图</label><button type="submit" class="btn primary tp-send">发送</button></div></form>';
  document.body.append(fab, panel);
  const $ = (s) => panel.querySelector(s);
  const msgsEl = $(".tp-msgs"), ta = $("textarea"), sendBtn = $(".tp-send"), imgChk = $(".tp-img");

  const QUICK = [
    ["用更简单的话讲讲这一节", false],
    ["这张图该怎么看？它说明了本课的哪个设计点？", true],
    ["考考我：就这一节出一道题", false],
    ["这个设计的代价和局限是什么？", false],
    ["这一节对应源码的哪个函数？", false],
    ["在 Claude Code / Codex 等现有 Agent 里，有没有类似的做法？", false],
  ];
  $(".tp-quick").innerHTML = QUICK.map((q, i) => '<button type="button" class="tp-q" data-i="' + i + '">' + q[0].split("？")[0].split("：")[0] + "</button>").join("");
  $(".tp-quick").addEventListener("click", (e) => {
    const b = e.target.closest(".tp-q"); if (!b) return;
    const q = QUICK[+b.dataset.i];
    if (q[1]) { imgChk.checked = true; }
    ask(q[0]);
  });

  /* ---------- 打开 / 关闭 ---------- */
  function open(focus = true) {
    document.body.classList.add("tutor-open");
    updateWhere(); render(); checkServer();
    if (focus) setTimeout(() => ta.focus({ preventScroll: true }), 50);
  }
  function close() { document.body.classList.remove("tutor-open"); }
  fab.addEventListener("click", () => { if (document.body.classList.contains("tutor-open")) { close(); savePanelPref("closed"); } else { open(); savePanelPref("open"); } });
  $(".tp-close").addEventListener("click", () => { close(); savePanelPref("closed"); });
  $(".tp-clear").addEventListener("click", () => { if (busy) stop(); history = []; save(); render(); });


  /* ---------- 当前上下文 ---------- */
  function currentSection() {
    const secs = [...document.querySelectorAll("main section.lesson-sec")];
    let cur = secs[0] || null;
    for (const s of secs) if (s.getBoundingClientRect().top < window.innerHeight * 0.35) cur = s;
    return cur;
  }
  function secTitle(sec) { const h = sec && sec.querySelector("h2"); return h ? h.innerText.replace(/\s+/g, " ").trim() : ""; }
  function updateWhere() {
    const parts = ["正在看：" + (secTitle(currentSection()) || lesson.title)];
    $(".tp-where").textContent = parts.join("");
    const a = [];
    if (pending && pending.chartCard) a.push('<span class="tp-chip">🖼 图示：' + esc(chartName(pending.chartCard)) + ' <button type="button" data-x="chart">✕</button></span>');
    if (pending && pending.selection) a.push('<span class="tp-chip">❝ ' + esc(pending.selection.slice(0, 40)) + (pending.selection.length > 40 ? "…" : "") + ' <button type="button" data-x="sel">✕</button></span>');
    $(".tp-attach").innerHTML = a.join("");
  }
  $(".tp-attach").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-x]"); if (!b || !pending) return;
    if (b.dataset.x === "chart") { pending.chartCard = null; imgChk.checked = false; } else pending.selection = null;
    updateWhere();
  });
  window.addEventListener("scroll", () => { if (document.body.classList.contains("tutor-open")) updateWhere(); }, { passive: true });
  function chartName(card) { const t = card.querySelector(".chart-title, figcaption, .cap"); return t ? t.innerText.replace(/\s+/g, " ").trim().slice(0, 60) : "图示"; }
  function chartControls(card) {
    return [...card.querySelectorAll("select, input")].map((x) => {
      const lab = (x.closest("label") || {}).innerText || x.id || "";
      const val = x.type === "checkbox" ? (x.checked ? "是" : "否") : x.tagName === "SELECT" ? x.options[x.selectedIndex].text : x.value;
      return lab.replace(/\s+/g, " ").trim().slice(0, 20) + "=" + val;
    }).join("，");
  }
  function gather() {
    const sec = currentSection();
    const card = (pending && pending.chartCard) || (imgChk.checked && sec ? visibleCard(sec) : null);
    const scope = card || sec;
    const readouts = scope ? [...scope.querySelectorAll(".readout, .chart-foot, table.tbl, figcaption, .diagram .cap, .diagram svg")].map((x) => (x.tagName.toLowerCase() === "svg" ? "【图示文字】" + [...x.querySelectorAll("text")].map((t) => t.textContent.trim()).filter(Boolean).join(" / ") : x.innerText.trim())).filter(Boolean).join("\n---\n") : "";
    const ctx = {
      title: lesson.id + " " + lesson.title,
      lessonText: (document.querySelector("main") || document.body).innerText,
      section: card ? secTitle(card.closest("section")) : secTitle(sec),
      selection: pending && pending.selection,
      readouts,
    };
    if (card) {
      ctx.chart = chartName(card) + (chartControls(card) ? "（当前设置：" + chartControls(card) + "）" : "");
      if (imgChk.checked || (pending && pending.chartCard)) ctx.needImage = card;
    }
    return ctx;
  }
  function visibleCard(sec) {
    const cards = [...sec.querySelectorAll(".chart-card, .fig, .diagram")];
    let best = null, bestD = Infinity;
    for (const c of cards) { const r = c.getBoundingClientRect(); const d = Math.abs(r.top + r.height / 2 - window.innerHeight / 2); if (d < bestD) { bestD = d; best = c; } }
    return best;
  }

  /* ---------- 图表卡片上的“问 AI”按钮 ---------- */
  document.querySelectorAll("main .chart-card, main .fig, main .diagram").forEach((card) => {
    const head = card.querySelector(".chart-head") || card; 
    const b = el("button", "btn tutor-ask", "问 AI"); b.type = "button"; b.title = "带着这张图（截图/图示文字 + 当前参数 + 读数）问 AI 助教";
    b.addEventListener("click", () => { pending = Object.assign(pending || {}, { chartCard: card }); imgChk.checked = true; open(); ta.value = ta.value || (card.classList.contains("chart-card") ? "这个演示该怎么看？现在的结果说明了什么？" : "这张图该怎么看？它说明了本课的哪个设计点？"); ta.focus(); });
    if (head === card) { b.style.position = "absolute"; b.style.top = "10px"; b.style.right = "10px"; if (getComputedStyle(card).position === "static") card.style.position = "relative"; }
    head.appendChild(b);
  });

  /* ---------- 选中文字 → 问 AI ---------- */
  const selBtn = el("button", "tutor-sel", "问 AI"); selBtn.type = "button"; document.body.appendChild(selBtn);
  document.addEventListener("mouseup", (e) => {
    if (panel.contains(e.target) || e.target === selBtn) return;
    setTimeout(() => {
      const s = window.getSelection(), t = s ? s.toString().trim() : "";
      if (!t || t.length < 2 || !s.rangeCount || !document.querySelector("main").contains(s.anchorNode)) { selBtn.style.display = "none"; return; }
      const r = s.getRangeAt(0).getBoundingClientRect();
      selBtn.style.left = Math.min(window.innerWidth - 90, r.right + window.scrollX + 6) + "px";
      selBtn.style.top = r.top + window.scrollY - 34 + "px";
      selBtn.style.display = "block"; selBtn.dataset.text = t;
    }, 0);
  });
  selBtn.addEventListener("click", () => {
    pending = Object.assign(pending || {}, { selection: selBtn.dataset.text.slice(0, 3000) });
    selBtn.style.display = "none"; open(); ta.value = ta.value || "请解释我选中的这段话。"; ta.focus();
  });

  /* ---------- 发送 ---------- */
  $(".tp-form").addEventListener("submit", (e) => { e.preventDefault(); if (busy) stop(); else ask(ta.value); });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) ask(ta.value); } });

  async function ask(q) {
    q = (q || "").trim(); if (!q || busy) return;
    if (!document.body.classList.contains("tutor-open")) open();
    if (serverOk === false || !isHttp) { render(); return; }
    const ctx = gather();
    if (ctx.needImage) { const card = ctx.needImage; delete ctx.needImage; ctx.image = await CL.snapshot(card); if (!ctx.image) delete ctx.image; }
    const meta = [ctx.chart ? "🖼 " + chartName((pending && pending.chartCard) || visibleCard(currentSection()) || document.body) : "", ctx.selection ? "❝ " + ctx.selection.slice(0, 60) : "", ctx.image ? "已附截图" : ""].filter(Boolean).join(" · ");
    history.push({ role: "user", content: q, meta });
    const ans = { role: "assistant", content: "", streaming: true };
    history.push(ans);
    ta.value = ""; pending = null; imgChk.checked = false; updateWhere();
    busy = true; sendBtn.textContent = "停止"; render();
    ctrl = new AbortController();
    try {
      const res = await fetch("/api/tutor/chat", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: ctrl.signal,
        body: JSON.stringify({ lesson: LESSON, context: ctx, messages: history.slice(0, -1).slice(-30).map((m) => ({ role: m.role, content: m.content })) }),
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "HTTP " + res.status); }
      const rd = res.body.getReader(), dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { value, done } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, k).trim(); buf = buf.slice(k + 2);
          if (!line.startsWith("data:")) continue;
          const d = JSON.parse(line.slice(5));
          if (d.thinking && !ans.content) ans.thinking = true;
          if (d.t) { ans.content += d.t; ans.thinking = false; }
          if (d.error) throw new Error(d.error);
          if (d.done && d.usage) ans.usage = d.usage.total_tokens;
          renderLast();
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") ans.error = String(e.message || e);
    } finally {
      ans.streaming = false; ans.thinking = false; busy = false; ctrl = null; sendBtn.textContent = "发送";
      if (!ans.content && !ans.error) ans.error = "已停止";
      save(); render();
    }
  }
  function stop() { if (ctrl) ctrl.abort(); }

  async function checkServer() {
    if (!isHttp) { serverOk = false; render(); return; }
    if (serverOk !== null) return;
    try {
      const r = await fetch("/api/tutor/health"); const j = await r.json();
      serverOk = !!j.ok; model = j.model || model; if (!j.ok) serverOk = false, (panel.dataset.err = j.error || "");
    } catch (e) { serverOk = false; }
    $(".tp-model").textContent = serverOk ? " · " + model : " · 未连接";
    render();
  }

  /* ---------- 渲染 ---------- */
  function render() {
    if (!isHttp || serverOk === false) {
      msgsEl.innerHTML = '<div class="tp-offline"><b>AI 助教需要本地服务。</b><p>' + (panel.dataset.err ? esc(panel.dataset.err) + "。" : "现在页面是直接从文件打开的，没法安全地调用 DeepSeek。") +
        "</p><p>在终端运行：</p><pre>cd lessons\nuv run --no-project python tools/serve.py</pre><p>然后打开 <a href=\"http://127.0.0.1:8771/lessons/" + LESSON + "\">http://127.0.0.1:8771/lessons/" + LESSON + "</a>。API key 只留在本机服务里，不进页面。</p></div>";
      return;
    }
    if (!history.length) {
      msgsEl.innerHTML = '<div class="tp-empty"><p>我读过本课的原文和全部内容。可以问我：</p><ul><li>没看懂的概念或句子（先在正文里选中它）</li><li>某张图或某个演示该怎么看（点它右上角的“问 AI”）</li><li>让我出题考你</li><li>这个设计和你熟悉的系统（操作系统、数据库、消息队列）有什么对应</li></ul><p class="data-note">回答由 ' + esc(model) + " 生成，可能出错；以原文为准。</p></div>";
      return;
    }
    msgsEl.innerHTML = history.map(msgHtml).join("");
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  function renderLast() {
    const last = msgsEl.lastElementChild, m = history[history.length - 1];
    if (last && m) { last.outerHTML = msgHtml(m); }
    const near = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 120;
    if (near) msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  function msgHtml(m) {
    if (m.role === "user") return '<div class="tp-msg user">' + (m.meta ? '<div class="tp-meta">' + esc(m.meta) + "</div>" : "") + "<div>" + esc(m.content).replace(/\n/g, "<br>") + "</div></div>";
    let body = m.content ? md(m.content) : m.thinking ? '<span class="tp-dots">思考中</span>' : m.streaming ? '<span class="tp-dots">连接中</span>' : "";
    if (m.error) body += '<div class="tp-err">⚠ ' + esc(m.error) + "</div>";
    return '<div class="tp-msg ai">' + body + (m.streaming && m.content ? '<span class="tp-caret"></span>' : "") + "</div>";
  }

  /* 极简 Markdown：先转义，再处理加粗、代码、标题、列表、段落（不执行任何 HTML） */
  function md(src) {
    const lines = esc(src).split("\n"); let out = "", list = null;
    const inline = (s) => s.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
    const flush = () => { if (list) { out += "</" + list + ">"; list = null; } };
    for (const raw of lines) {
      const l = raw.trimEnd(); let m;
      if (!l.trim()) { flush(); continue; }
      if ((m = l.match(/^#{1,4}\s+(.*)/))) { flush(); out += "<h4>" + inline(m[1]) + "</h4>"; continue; }
      if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { if (list !== "ul") { flush(); out += "<ul>"; list = "ul"; } out += "<li>" + inline(m[1]) + "</li>"; continue; }
      if ((m = l.match(/^\s*\d+[.)、]\s+(.*)/))) { if (list !== "ol") { flush(); out += "<ol>"; list = "ol"; } out += "<li>" + inline(m[1]) + "</li>"; continue; }
      if (/^\s*(---|\*\*\*)\s*$/.test(l)) { flush(); out += "<hr>"; continue; }
      if (/^\|.*\|$/.test(l.trim())) { flush(); out += '<div class="tp-tbl">' + inline(l) + "</div>"; continue; }
      flush(); out += "<p>" + inline(l) + "</p>";
    }
    flush(); return out;
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function el(tag, cls, html) { const e = document.createElement(tag); e.className = cls; if (html) e.innerHTML = html; return e; }

  // 默认常开。直接双击打开文件（file://）时助教用不了，默认收起，按钮上注明“未连接”
  const pref = panelPref();
  if (/[?&]tutor=1/.test(location.search) || pref === "open" || (pref !== "closed" && isHttp)) open(false);
  if (!isHttp) fab.innerHTML = '<span class="seal">问</span>AI 助教 <small>· 未连接</small>';
})();
