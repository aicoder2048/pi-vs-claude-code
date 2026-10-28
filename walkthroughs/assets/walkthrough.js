// 走读页共用交互：源码面板、双循环动画、四层步进。
// 在 <head> 里紧跟 shell.js 同步加载。本文件只定义全局 WT，加载时不碰 DOM；
// 页面在 </main> 之后的内联 <script> 里调用 WT.source / WT.loops / WT.layers，那时 DOM 已经就绪。
// 页面只写数据和扩展专属函数（预览渲染、状态更新、模拟器），机制都在这里。API 说明见 .claude/skills/ext-walkthrough/SKILL.md。
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const $ = id => {
    const n = document.getElementById(id);
    if (!n) throw new Error(`walkthrough.js：页面缺少 #${id}`);
    return n;
  };
  const moveDot = (dot, x, y) => { dot.style.transform = `translate(${x}px, ${y}px)`; };
  const flash = el => { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 220); };
  const TAGTXT = { l1: 'L1', l2: 'L2', l3: 'L3', l4: 'L4', hit: '回调' };

  // ─────────── 源码面板 ───────────
  // lines：[行号, 代码, 'l1'|'l2'|'l3'|'l4'|'hit', 解释 HTML]。挂到 #src-lines，解释写进 #src-explain。
  function source(lines) {
    const box = $('src-lines'), explain = $('src-explain');
    lines.forEach(([n, code, layer, why]) => {
      if (!TAGTXT[layer]) throw new Error(`WT.source：第 ${n} 行的层 "${layer}" 不认识`);
      const d = document.createElement('div');
      d.className = 'ln';
      d.innerHTML = `<span class="n">${n}</span><span></span><span class="t"><span class="tag ${layer}">${TAGTXT[layer]}</span></span>`;
      d.children[1].textContent = code;
      d.onclick = () => {
        box.querySelectorAll('.ln').forEach(x => x.classList.remove('on'));
        d.classList.add('on');
        explain.innerHTML = `<span class="tag ${layer}">${TAGTXT[layer]}</span> <b>第 ${n} 行</b> · ${why}`;
      };
      box.appendChild(d);
    });
  }

  // ─────────── 双循环图 ───────────
  // 所有扩展共用同一张图：节点 id、坐标、箭头都固定在这里，页面只声明 hit / 副标题 / 图例。
  // [key, x, y, 事件名, 事件名字号, 默认副标题]
  const NODES = [
    ['session', 90, 30, 'session_start', 12, '启动 1 次 · 循环外'],
    ['input', 300, 30, 'input', 12, '用户回车'],
    ['bas', 470, 30, 'before_agent_start', 11.5, '每次 settle 1 次'],
    ['settled', 670, 30, 'agent_settled', 12, '空闲'],
    ['astart', 130, 115, 'agent_start', 12, 'run 开始'],
    ['tstart', 130, 210, 'turn_start', 12, '吸收 steering'],
    ['llm', 300, 210, 'context → LLM', 12, 'transformContext'],
    ['msg', 470, 210, 'message_*', 12, 'start / update / end'],
    ['tools', 470, 320, 'tool_call/result', 12, '执行工具'],
    ['tend', 300, 320, 'turn_end', 12, '取 steering'],
    ['aend', 670, 320, 'agent_end', 12, 'run 结束'],
    ['post', 670, 240, '_handlePostAgentRun', 11.5, 'retry/compaction/排队?'],
    ['settle', 670, 160, 'agent_before_settle', 11.5, '扩展要 continue?'],
  ];
  const POS = Object.fromEntries(NODES.map(([k, x, y]) => [k, [x, y]]));
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const LOOP_FRAME = `
  <defs>
    <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ah" d="M0,0L10,5L0,10z"/></marker>
    <marker id="ah-o" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ah o" d="M0,0L10,5L0,10z"/></marker>
    <marker id="ah-i" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ah i" d="M0,0L10,5L0,10z"/></marker>
  </defs>

  <rect class="box-outer" x="30" y="70" width="760" height="340" rx="14"/>
  <text class="t-outer" x="46" y="92" font-size="13">settle 外循环 · 续跑—停稳</text>
  <text class="mut mono" x="232" y="92" font-size="10.5">agent-session.ts:1873</text>
  <rect class="box-inner" x="50" y="145" width="500" height="235" rx="12"/>
  <text class="t-inner" x="66" y="167" font-size="13">run 内循环 · 模型—工具</text>
  <text class="mut mono" x="232" y="167" font-size="10.5">agent-loop.ts:188</text>

  <path class="arrow" marker-end="url(#ah)" d="M372,30 L396,30"/>
  <path class="arrow o" marker-end="url(#ah-o)" d="M470,49 L470,115 L204,115"/>
  <path class="arrow i" marker-end="url(#ah-i)" d="M130,134 L130,189"/>
  <path class="arrow i" marker-end="url(#ah-i)" d="M202,210 L226,210"/>
  <path class="arrow i" marker-end="url(#ah-i)" d="M372,210 L396,210"/>
  <path class="arrow i" marker-end="url(#ah-i)" d="M470,229 L470,299"/>
  <text class="mut" x="478" y="268" font-size="10">有 toolCall</text>
  <path class="arrow i" marker-end="url(#ah-i)" d="M398,320 L374,320"/>
  <path class="arrow i" marker-end="url(#ah-i)" stroke-dasharray="4 3" d="M420,229 L340,299"/>
  <text class="mut" x="352" y="262" font-size="10">无</text>
  <path class="arrow i" marker-end="url(#ah-i)" d="M250,301 L160,231"/>
  <text class="t-inner" x="92" y="276" font-size="10.5">↺ 下一 turn</text>
  <text class="mut" x="64" y="291" font-size="9.5">工具结果 / steering / follow-up</text>
  <path class="arrow" marker-end="url(#ah)" d="M300,339 L300,365 L580,365 L580,320 L596,320"/>
  <text class="mut" x="392" y="360" font-size="10">都没了 → run 结束</text>
  <path class="arrow o" marker-end="url(#ah-o)" d="M670,301 L670,261"/>
  <path class="arrow o" marker-end="url(#ah-o)" d="M670,221 L670,181"/>
  <text class="mut" x="676" y="205" font-size="10">否</text>
  <path class="arrow o" marker-end="url(#ah-o)" d="M670,141 L670,51"/>
  <text class="mut" x="676" y="64" font-size="10">否 → 退出</text>
  <path class="arrow o" marker-end="url(#ah-o)" d="M742,240 L775,240 L775,395 L40,395 L40,115 L56,115"/>
  <path class="arrow o" d="M742,160 L775,160 L775,240"/>
  <text class="t-outer" x="290" y="390" font-size="10.5">↺ agent.continue() → 新 run</text>
  <text class="mut" x="560" y="390" font-size="9.5">retry / compaction / 排队 / continue</text>
`;

  function loopSvg(hit, sub, legend) {
    const nodes = NODES.map(([k, x, y, label, fs, sub0]) =>
      `  <g class="node${hit.includes(k) ? ' hit' : ''}" id="n-${k}" transform="translate(${x},${y})"><rect x="-72" y="-19" width="144" height="38" rx="8"/>` +
      `<text class="mono" text-anchor="middle" y="-2" font-size="${fs}">${esc(label)}</text>` +
      `<text class="mut" text-anchor="middle" y="13" font-size="9.5">${esc(sub[k] ?? sub0)}</text></g>`).join('\n');
    // 图例：一个字符串画一行（y=440）；数组画两行（y=432、448），一行放不下时用
    const lines = Array.isArray(legend) ? legend : [legend];
    if (lines.length > 2) throw new Error('WT.loops：legend 最多两行');
    const ys = lines.length === 2 ? [432, 448] : [440];
    const legendSvg = lines.map((t, i) => `  <text class="mut" x="30" y="${ys[i]}" font-size="10.5">${esc(t)}</text>\n`).join('');
    return `<svg viewBox="0 0 820 455" role="img" aria-label="Pi 双循环与回调点">${LOOP_FRAME}\n${nodes}\n\n` +
      `${legendSvg}  <g id="dot1" class="dot"><circle r="7"/></g>\n</svg>`;
  }

  // ─────────── 双循环动画 ───────────
  // opts.hit      本扩展订阅的节点 key 数组，加橙框
  // opts.sub      { 节点 key: 副标题 }，覆盖默认副标题（可省）
  // opts.legend   图下方的图例文字（纯文本）；放不下一行时传两个字符串的数组
  // opts.scenes   { 场景 key: [步骤…] }，key 对应 #scn 的 <option value>
  //               步骤：[节点 key, 事件文字, 'outer'|'inner'|'', 状态补丁对象, 说明, run+, turn+]
  // opts.state()  返回本页的初始状态对象；每步先 Object.assign(状态, 补丁)
  // opts.onStep(st, s)   可省：合并补丁之后、预览之前，做补丁表达不了的更新（例如累加计数）
  // opts.preview(st, s)  每步调用，按状态画“本扩展效果预览”；s = { node, event, loop, patch, note, index }
  // opts.idle()   重置时调用：把预览区恢复成“还没启动”
  // opts.logTag(s)  可省：返回这一步日志行前的 tag HTML；返回假值用默认（外 / 内 / 外部）
  // 页面要提供：#loops-fig（空容器）、#scn、#play、#step、#reset、#ctr、#log1
  function loops(opts) {
    const { hit = [], sub = {}, legend = '', scenes, state, onStep, preview, idle, logTag, interval = 1100 } = opts;
    if (!scenes || typeof state !== 'function' || typeof preview !== 'function' || typeof idle !== 'function') {
      throw new Error('WT.loops：scenes、state()、preview()、idle() 都必须提供');
    }
    [...hit, ...Object.keys(sub)].forEach(k => { if (!POS[k]) throw new Error(`WT.loops：没有节点 "${k}"`); });
    Object.entries(scenes).forEach(([key, steps]) => steps.forEach((s, i) => {
      if (!POS[s[0]]) throw new Error(`WT.loops：场景 ${key} 第 ${i + 1} 步的节点 "${s[0]}" 不存在`);
      if (s[3] === null || typeof s[3] !== 'object') throw new Error(`WT.loops：场景 ${key} 第 ${i + 1} 步的状态补丁必须是对象（没变化写 {}）`);
    }));
    $('loops-fig').innerHTML = loopSvg(hit, sub, legend);

    const dot = $('dot1'), log = $('log1'), ctr = $('ctr'), play = $('play'), scn = $('scn');
    let idx = -1, run = 0, turn = 0, timer = null, st = {};
    const steps = () => {
      const S = scenes[scn.value];
      if (!S) throw new Error(`WT.loops：没有场景 "${scn.value}"`);
      return S;
    };
    const clearActive = () => document.querySelectorAll('[id^="n-"]').forEach(n => n.classList.remove('active'));
    function stop() { clearInterval(timer); timer = null; play.textContent = '▶ 播放'; }
    function reset() {
      stop(); idx = -1; run = 0; turn = 0; st = state();
      log.innerHTML = '';
      clearActive();
      moveDot(dot, 18, 30);
      idle();
      ctr.textContent = 'run 0 · turn 0';
    }
    function step() {
      const S = steps();
      if (idx >= S.length - 1) { stop(); return; }
      idx++;
      const [node, event, loop, patch, note, dr, dt] = S[idx];
      if (dr) { run++; turn = 0; }
      if (dt) turn++;
      Object.assign(st, patch);
      const s = { node, event, loop, patch, note, index: idx };
      if (onStep) onStep(st, s);
      clearActive();
      $('n-' + node).classList.add('active');
      const [x, y] = POS[node]; moveDot(dot, x - 72, y);
      preview(st, s);
      const li = document.createElement('li');
      const tag = (logTag && logTag(s)) ||
        (loop ? `<span class="tag ${loop}">${loop === 'outer' ? '外' : '内'}</span>` : `<span class="tag hit">外部</span>`);
      li.innerHTML = `${tag}<span></span>`;
      li.children[1].textContent = `${event}${note ? ' — ' + note : ''}`;
      log.appendChild(li); log.scrollTop = log.scrollHeight;
      ctr.textContent = `run ${run} · turn ${turn}`;
      if (idx >= S.length - 1) stop();
    }
    play.onclick = () => {
      if (timer) { stop(); return; }
      if (idx >= steps().length - 1) reset();
      play.textContent = '❚❚ 暂停';
      step(); timer = setInterval(step, interval);
    };
    $('step').onclick = () => { stop(); step(); };
    $('reset').onclick = reset;
    scn.onchange = reset;
    reset();
  }

  // ─────────── 四层步进 ───────────
  // opts.chips  { key: [文字, x, 宽, 层中心 y, 是否用到 1|0] }；层中心 y：L4=51、L3=147、L2=243、L1=339
  // opts.boot   [[chip key, 说明 HTML], …]，按顺序连成路径
  // opts.start  第 0 步时圆点的位置 [x, y]（默认 [165, 339]，即 L1 左侧）
  // 页面要提供：四层 SVG 里的 #chips、#bootpath、#dot2，以及 #b-prev、#b-next、#b-ctr、#b-text
  function layers(opts) {
    const { chips, boot, start = [165, 339] } = opts;
    boot.forEach(([k], i) => { if (!chips[k]) throw new Error(`WT.layers：第 ${i + 1} 步的 chip "${k}" 不存在`); });
    const g0 = $('chips');
    Object.entries(chips).forEach(([, [t, x, w, y, hit]]) => {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'chip' + (hit ? ' hit' : ''));
      g.innerHTML = `<rect x="${x}" y="${y - 15}" width="${w}" height="30" rx="6"/><text x="${x + w / 2}" y="${y + 4}" text-anchor="middle" font-size="10.5"></text>`;
      g.querySelector('text').textContent = t;
      if (!hit) g.querySelector('text').setAttribute('class', 'mut');
      g0.appendChild(g);
    });
    const center = k => { const [, x, w, y] = chips[k]; return [x + w / 2, y]; };
    $('bootpath').setAttribute('points', boot.map(([k]) => center(k).join(',')).join(' '));
    const dot = $('dot2'), ctr = $('b-ctr'), prev = $('b-prev'), next = $('b-next'), text = $('b-text');
    let bi = -1;
    function draw() {
      ctr.textContent = `${bi + 1} / ${boot.length}`;
      prev.disabled = bi < 0;
      next.disabled = bi >= boot.length - 1;
      if (bi < 0) { moveDot(dot, start[0], start[1]); return; }
      const [k, html] = boot[bi];
      const [x, y] = center(k); moveDot(dot, x - chips[k][2] / 2, y);
      text.innerHTML = `<b>${bi + 1}.</b> ${html}`;
    }
    next.onclick = () => { bi = Math.min(boot.length - 1, bi + 1); draw(); };
    prev.onclick = () => { bi = Math.max(-1, bi - 1); draw(); };
    draw();
  }

  window.WT = { source, loops, layers, flash, moveDot };
})();
