import { at, colorName, glyph, inCheck, legalMoves, other, replay, same, type Analysis, type Color, type Move, type Point, type Position } from '../business/engine';
import { REASON_TEXT, type Command, type GameState, type ModelChoice } from '../shared/types';
import type { Risk } from '../business/expert';
import { setupLearningUI } from './learning-ui';
import { Ambience, type MusicStyle } from './audio';
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (id: string, value: string) => { el(id).textContent = value; };
const button = (id: string) => el<HTMLButtonElement>(id);
const input = (id: string) => el<HTMLInputElement>(id);
const select = (id: string) => el<HTMLSelectElement>(id);
const dialog = (id: string) => el<HTMLDialogElement>(id);
const audio = new Ambience(el<HTMLAudioElement>('background-music'));
let state: GameState, models: ModelChoice[] = [], view: number | null = null, flipped = false, selected: Point | null = null;
let hints = true, animations = !matchMedia('(prefers-reduced-motion: reduce)').matches, busy = false, cursor: Point | null = null;
let lastRecordKey = '', toastTimer: ReturnType<typeof setTimeout>;
// Per-ply reports fetched on demand; pushed states omit them. Cleared on a new game or undo.
const evaluations = new Map<number, Analysis | null>();
const nodes = new Map<string, HTMLButtonElement>();
function toast(message: string) { text('toast', message); el('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => el('toast').hidden = true, 4600); }
async function command(c: Command): Promise<boolean> {
  if (busy) return false;
  busy = true;
  try { const r = await window.chess.command(c); if (!r.ok) { toast(r.error); return false; } receive(r.value); return true; }
  catch (error) { toast(String(error)); return false; }
  finally { busy = false; }
}
function displayPosition(): Position { return view === null ? state.position : replay(state.position.moves.slice(0, view)); }
function xy(p: Point): Point { return flipped ? { x: 8 - p.x, y: 9 - p.y } : { ...p }; }
function place(node: HTMLElement, p: Point) { const q = xy(p); node.style.left = `${(q.x + .5) / 9 * 100}%`; node.style.top = `${(q.y + .5) / 10 * 100}%`; }
function staticBoard() {
  const lines: string[] = [];
  for (let y = 0; y < 10; y++) lines.push(`<path d="M50 ${50 + y * 100}H850"/>`);
  for (let x = 0; x < 9; x++) { const a = 50 + x * 100; lines.push(x === 0 || x === 8 ? `<path d="M${a} 50V950"/>` : `<path d="M${a} 50V450 M${a} 550V950"/>`); }
  lines.push('<path d="M350 50L550 250 M550 50L350 250 M350 750L550 950 M550 750L350 950"/>');
  for (const y of [2, 3, 6, 7]) for (const x of y === 2 || y === 7 ? [1, 7] : [0, 2, 4, 6, 8]) {
    const a = 50 + x * 100, b = 50 + y * 100;
    for (const dx of [-1, 1]) for (const dy of [-1, 1]) if (x + dx >= 0 && x + dx <= 8) lines.push(`<path d="M${a + dx * 12} ${b + dy * 28}V${b + dy * 12}H${a + dx * 28}"/>`);
  }
  const labels = Array.from({ length: 9 }, (_, x) => `<text x="${50 + x * 100}" y="987" text-anchor="middle" font-size="18">${String.fromCharCode(65 + (flipped ? 8 - x : x))}</text>`).join('') + Array.from({ length: 10 }, (_, y) => `<text x="16" y="${57 + y * 100}" text-anchor="middle" font-size="17">${flipped ? 9 - y : y}</text>`).join('');
  el('board-art').innerHTML = `<rect x="32" y="32" width="836" height="936" rx="2" fill="none" stroke="#866131" stroke-width="4"/><g class="grid">${lines.join('')}</g><text x="250" y="518" font-size="51" letter-spacing="24" text-anchor="middle">楚河</text><text x="650" y="518" font-size="51" letter-spacing="24" text-anchor="middle">汉界</text>${labels}`;
}
function marker(kind: string, p: Point) { const n = document.createElement('div'); n.className = `marker ${kind}`; place(n, p); el('markers').append(n); }
function transient(node: HTMLElement, ms: number) { el('effects').append(node); setTimeout(() => node.remove(), ms); }
function effect(move: Move) {
  if (!animations) return;
  if (move.captured) {
    const ghost = document.createElement('span'); ghost.className = `piece captured ${move.captured.color === 1 ? 'red' : ''}`; ghost.textContent = glyph(move.captured); place(ghost, move.to); transient(ghost, 600);
    const ring = document.createElement('span'); ring.className = 'ripple'; place(ring, move.to); transient(ring, 700);
    for (let i = 0; i < 7; i++) {
      const spark = document.createElement('span'); spark.className = 'spark'; spark.textContent = i % 2 ? '✦' : '·'; place(spark, move.to);
      const a = Math.PI * 2 * i / 7;
      spark.style.setProperty('--dx', `${Math.cos(a) * 65}px`); spark.style.setProperty('--dy', `${Math.sin(a) * 65 - 25}px`); transient(spark, 800);
    }
  }
  if (move.check || move.captured) { const n = document.createElement('span'); n.className = 'shout'; n.textContent = move.check ? '将 军' : move.piece.kind === 'cannon' ? '隔山打炮' : move.piece.kind === 'horse' ? '马到功成' : '吃 子'; transient(n, 1150); }
  const n = nodes.get(move.piece.id);
  if (n) n.animate([{ transform: 'translate(-50%,-50%) scale(1)' }, { transform: `translate(-50%,-${move.piece.kind === 'horse' ? 83 : 63}%) scale(1.08)` }, { transform: 'translate(-50%,-50%) scale(1)' }], { duration: 360, easing: 'ease-out' });
}
function renderBoard(animate = false) {
  const p = displayPosition(), live = view === null, last = p.moves.at(-1), ids = new Set<string>();
  el('board').classList.toggle('no-animation', !animations || !animate);
  for (const piece of p.board) {
    if (!piece) continue;
    ids.add(piece.id);
    let n = nodes.get(piece.id);
    if (!n) { n = document.createElement('button'); n.className = 'piece'; n.tabIndex = -1; el('pieces').append(n); nodes.set(piece.id, n); }
    n.style.fontSize = 'inherit';
    n.textContent = glyph(piece);
    n.setAttribute('aria-label', `${colorName(piece.color)}${glyph(piece)} ${String.fromCharCode(65 + piece.x)}${piece.y}`);
    n.className = `piece ${piece.color === 1 ? 'red' : ''}${selected && same(selected, piece) ? ' selected' : ''}${last && same(last.to, piece) ? ' last' : ''}${piece.kind === 'king' && inCheck(p.board, piece.color) ? ' checked' : ''}`;
    place(n, piece);
  }
  for (const [id, n] of nodes) if (!ids.has(id)) { n.remove(); nodes.delete(id); }
  el('markers').replaceChildren();
  if (last) marker('origin', last.from);
  if (cursor) marker('cursor', cursor);
  if (selected && live && hints) for (const m of legalMoves(p, selected)) marker(at(p.board, m.to) ? 'capture-ring' : 'legal-dot', m.to);
  text('black-captured', p.moves.filter(m => m.captured?.color === 2).map(m => glyph(m.captured!)).join(''));
  text('red-captured', p.moves.filter(m => m.captured?.color === 1).map(m => glyph(m.captured!)).join(''));
  if (animate && last) effect(last);
}
function time(ms: number) { const s = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
function renderClocks() {
  const settings = state.match.settings;
  for (const [id, color] of [['human', state.human], ['machine', other(state.human)]] as const) {
    const ms = state.clock.players[color].mainMs;
    text(`${id}-time`, time(ms)); text(`${id}-color`, `执${colorName(color)} · ${color === 1 ? '先手' : '后手'}`);
    text(`${id}-clock-info`, `${settings.timeControl === 'fischer' ? `每步 +${settings.incrementMs / 1000} 秒` : '包干制'}${state.clock.running === color ? ` · 本手 ${time(state.clock.turnElapsedMs)}` : ''}`);
    el(`${id}-clock`).classList.toggle('active', state.clock.running === color);
    el(`${id}-clock`).classList.toggle('low', ms < 30000 && state.clock.running === color);
  }
}
function renderStatus() {
  const reviewing = view !== null;
  let badge = reviewing ? '棋谱回看' : state.status === 'thinking' ? '大模型思考中' : state.status === 'human' ? '轮到你了' : state.status === 'over' ? state.match.winner ? '比赛结束' : '本局结束' : state.status === 'error' ? '模型请求未完成' : '等待继续';
  let title = state.position.moves.length ? state.analysis.inCheck ? '将军！先护好将帅' : '运筹帷幄，步步为营' : '楚河汉界，落子有声';
  let description = state.error || (state.status === 'thinking' ? '大模型正通过 Pi 分析棋局、试算变化。思考与网络等待均计入它的棋钟。' : state.status === 'human' ? '点击己方棋子，再点击目标位置。绿点为合法走法，红圈为可吃棋子。' : '请求已停止，棋钟继续。点击「继续 / 重试」让大模型行棋。');
  if (state.outcome) {
    title = state.outcome.winner === 'draw' ? '此局言和，再论高下' : state.outcome.winner === state.human ? '你赢下了这一局' : '大模型赢下了这一局';
    description = `${REASON_TEXT[state.outcome.reason]}。${state.match.winner ? `比赛结束，${state.match.winner === 'human' ? '你' : '大模型'}赢得本场比赛。` : '下一局重新配时；胜负局交换红黑，和棋同色重赛。'}`;
  }
  if (reviewing) { title = `回看 · 第 ${view} 手`; description = '当前为历史局面，不能走子。实战棋钟仍在运行，点击「回到实战」继续。'; }
  text('status-badge', badge); text('status-title', title); text('status-description', description);
  text('view-label', reviewing ? `回看 ${view} / ${state.position.moves.length}` : `${colorName(state.position.next)}方行棋 · 9 × 10`);
  text('match-format', state.match.settings.bestOf === 3 ? '三局两胜' : '五局三胜');
  text('round-label', `第 ${state.outcome?.number ?? state.match.rounds.length + 1} 局`);
  text('human-wins', String(state.match.humanWins)); text('machine-wins', String(state.match.machineWins));
  text('match-detail', `先胜 ${Math.ceil(state.match.settings.bestOf / 2)} 局夺魁 · 和棋 ${state.match.draws} 局`);
  button('next-round').hidden = !state.outcome || !!state.match.winner;
  button('retry').disabled = !!state.outcome || state.status === 'thinking' || state.position.next === state.human;
  button('cancel').disabled = state.status !== 'thinking'; button('resign').disabled = !!state.outcome;
  button('undo').disabled = !!state.outcome || !state.match.settings.allowUndo || !state.position.moves.some(m => m.color === state.human);
  const note = [...state.notes].reverse().find(n => n.ply <= (view ?? state.position.moves.length));
  text('reason-text', note?.reason || '等大模型落子后，这里会记录它公开的落子理由。');
  text('reason-meta', note ? `第 ${note.ply} 手 · ${(note.elapsedMs / 1000).toFixed(1)} 秒 · ${note.model}` : '只记录公开落子理由，不展示私有思维链。');
  const range = input('replay'); range.max = String(state.position.moves.length); range.value = String(view ?? state.position.moves.length);
  button('back').disabled = (view ?? state.position.moves.length) === 0; button('forward').disabled = view === null || view >= state.position.moves.length;
  select('model').value = state.model ? `${state.model.provider}/${state.model.id}` : '';
}
function renderRecord() {
  const recordKey = `${state.id}/${state.position.moves.length}/${view}/${state.revision}`;
  if (lastRecordKey === recordKey) return;
  lastRecordKey = recordKey;
  text('record-count', `${state.position.moves.length} 手`);
  const list = el('moves'); list.replaceChildren();
  if (!state.position.moves.length) { const n = document.createElement('p'); n.className = 'empty-record'; n.textContent = '车马未动，山河已在。\n红方先行'; list.append(n); }
  state.position.moves.forEach((move, i) => {
    const n = document.createElement('button'); n.className = `${move.color === 1 ? 'red' : ''} ${(view ?? state.position.moves.length) === i + 1 ? 'current' : ''}`;
    const number = document.createElement('b'); number.textContent = String(i + 1).padStart(2, '0'); const label = document.createElement('span'); label.textContent = move.notation;
    n.append(number, label); n.onclick = () => review(i + 1); list.append(n);
  });
  if (view === null) list.scrollTop = list.scrollHeight;
}
const RISK_TEXT: Record<Risk, string> = { win: '终局获胜', loss: '已发现直接败着反例', 'material-loss': '明显亏子估计', 'exchange-risk': '交换风险', uncertain: '覆盖不足，不能判安全', 'no-direct-loss-found': '未发现直接亏子，非安全证明' };
function renderExpert() {
  const container = el('expert-report'); container.replaceChildren();
  if (view !== null && view > 0 && !evaluations.has(view)) {
    const id = state.id, ply = view;
    text('expert-summary', `正在读取第 ${ply} 手的专家报告…`);
    void window.chess.evaluation(id, ply).then(r => {
      if (state.id !== id) return;
      evaluations.set(ply, r.ok ? r.value : null);
      if (view === ply && dialog('expert-dialog').open) renderExpert();
    });
    return;
  }
  const report = (view === null ? state.analysis : view > 0 ? evaluations.get(view) : undefined)?.expert;
  if (!report) { text('expert-summary', '这个历史局面没有保存专家报告，请回到实战查看。'); return; }
  text('expert-summary', `${view === null ? '实战' : `回看第 ${view} 手`} · ${{ opening: '开局', middlegame: '中局', endgame: '残局' }[report.phase]} · ${colorName(report.perspective)}方视角，子力差 ${report.material.balanceForSideToMove} · 审查 ${report.coverage.reviewedMoves}/${report.coverage.totalMoves} 个候选`);
  const node = (tag: string, value: string) => { const n = document.createElement(tag); n.textContent = value; return n; };
  const section = (title: string) => { const n = document.createElement('section'); n.className = 'expert-section'; n.append(node('h3', title)); container.append(n); return n; };
  const priorities = section('当前应先处理什么');
  for (const value of report.priorities) priorities.append(node('p', value));
  const sourced = section('按需注入的定式与来源知识');
  if (!report.knowledge?.length) sourced.append(node('p', '没有匹配到本包覆盖的定式或条件资料，不强行套用。'));
  for (const k of report.knowledge ?? []) { const article = document.createElement('article'); article.append(node('h4', k.title), node('p', k.applicability), node('p', k.advice), node('small', `例外：${k.caution}`), node('small', `来源：${k.source.title} ${k.source.url}`)); if (k.currentLine) article.append(node('p', `当前复核：${k.currentLine.join(' → ')}`)); sourced.append(article); }
  const learned = section('赛后案例检索 · 当前已重验');
  if (!report.experiences?.length) learned.append(node('p', '暂无具有当前计算证据的匹配案例。不是把所有历史案例塞进上下文。'));
  for (const e of report.experiences ?? []) { const article = document.createElement('article'); article.append(node('h4', e.title), node('p', `${e.match} · ${e.advice}`), node('p', `当前变化：${e.currentLine.join(' → ')} · 交换估计 ${e.currentNet}`), node('small', `来自 ${e.sourceCount} 个已验证样本；案例 ${e.caseId}。历史变例仅供参考，不自动落子。`)); learned.append(article); }
  const formation = section('子力协调与九宫');
  for (const [label, f] of [['红方', report.formation.red], ['黑方', report.formation.black]] as const) formation.append(node('p', `${label}：${f.advisors} 士仕 / ${f.elephants} 相象；将帅合法出口 ${f.legalKingExits}；未离底线车马 ${f.undevelopedMajors.join('、') || '无'}；${f.horseMobility.map(x => `${x.piece} ${x.destinations} 个合法落点`).join('，')}`));
  const principles = section('按当前局面触发的专家知识');
  for (const rule of report.principles) { const article = document.createElement('article'); article.append(node('h4', rule.title), node('p', rule.advice), node('small', `依据：${rule.evidence.join('；') || '当前阶段'}`)); principles.append(article); }
  const safety = section('受攻击棋子与将帅牵制');
  const issues = report.safety.filter(x => x.legalAttackers.length || x.pinnedToKing);
  if (!issues.length) safety.append(node('p', '未发现合法直接吃子目标或移子暴露将帅的牵制；这不等于没有战术威胁。'));
  for (const item of issues) safety.append(node('p', `${item.piece}：${item.legalAttackers.length ? `可被 ${item.legalAttackers.join('、')} 合法吃到` : '无直接合法吃子'}；几何保护 ${item.geometricDefenders.join('、') || '无'}${item.pinnedToKing ? '；离位会暴露将帅' : ''}。`));
  const candidates = section('候选与对手反击（评分仅供比较）');
  for (const r of report.candidates.slice(0, 6)) {
    const article = document.createElement('article');
    if (r.risk === 'loss' || r.risk === 'material-loss') article.className = 'risk-warning';
    article.append(node('h4', `${r.notation} · ${RISK_TEXT[r.risk]}`), node('p', `交换估计净收益 ${r.estimatedNet}，位置变化 ${r.positionalDelta}。${r.line.slice(1).join(' → ') || '没有列出直接反击变化。'}`), node('small', `对方应手覆盖 ${r.coverage.checkedReplies}/${r.coverage.totalReplies}；${r.coverage.exchangeComplete ? '已完成设定的同格交换范围' : '交换深度或预算截断'}。${r.warnings.join(' ')}`)); candidates.append(article);
  }
  const note = [...state.notes].reverse().find(n => n.ply <= (view ?? state.position.moves.length));
  if (note?.review) { const s = section('最近一次机器提交的独立复查'); s.append(node('p', `第 ${note.ply} 手：${note.review.notation} · ${RISK_TEXT[note.review.risk]} · 交换估计 ${note.review.estimatedNet}`)); if (note.riskAcknowledgement) s.append(node('p', `模型明确接受风险：${note.riskAcknowledgement}`)); }
  const limits = section('计算边界'); for (const limit of report.limitations) limits.append(node('p', limit));
}
function renderLogs() { text('logs', state.logs.map(l => `${new Date(l.time).toLocaleTimeString()} [${l.layer}] ${l.text}`).join('\n') || '等待第一步走子。'); if (!el('layers').hidden) el('logs').scrollTop = el('logs').scrollHeight; }
function receive(next: GameState) {
  // Invocation replies can arrive after a newer push; never rewind authority.
  if (state && (next.revision < state.revision || (next.revision === state.revision && next.clock.updatedAt < state.clock.updatedAt))) return;
  const changedGame = !state || state.id !== next.id;
  const changedBoard = changedGame || state.position.moves.length !== next.position.moves.length || state.revision !== next.revision;
  const animate = !changedGame && view === null && next.position.moves.length === state.position.moves.length + 1;
  if (changedGame || next.position.moves.length < state.position.moves.length) evaluations.clear();
  state = next;
  if (changedGame) { view = null; flipped = state.human === 2; selected = null; cursor = null; el('effects').replaceChildren(); staticBoard(); }
  if (changedBoard) { selected = null; if (view !== null) view = Math.min(view, state.position.moves.length); renderBoard(animate); if (animate && input('sound').checked) void audio.stone().catch(() => {}); }
  renderClocks(); renderStatus(); renderRecord(); renderLogs();
  if (changedBoard && dialog('expert-dialog').open) renderExpert();
}
function review(ply: number | null) { view = ply; selected = null; cursor = null; renderBoard(); renderStatus(); renderRecord(); if (dialog('expert-dialog').open) renderExpert(); }
function activate(point: Point) {
  if (!state || busy) return;
  if (view !== null) { toast('回看中，请先回到实战'); return; }
  if (state.status !== 'human') { toast(state.outcome ? '本局已结束' : '请等待大模型行棋'); return; }
  const p = at(state.position.board, point);
  if (p?.color === state.human) { selected = selected && same(selected, point) ? null : point; renderBoard(); return; }
  if (!selected) return;
  const move = { from: { ...selected }, to: { ...point } };
  if (!legalMoves(state.position, selected).some(m => same(m.to, point))) { toast('这一步不合法，请检查走法及将帅安全'); return; }
  void command({ type: 'move', ...move, revision: state.revision });
}
el('board').addEventListener('click', event => {
  const r = el('board').getBoundingClientRect(), p = { x: Math.floor((event.clientX - r.left) / r.width * 9), y: Math.floor((event.clientY - r.top) / r.height * 10) };
  if (p.x < 0 || p.x > 8 || p.y < 0 || p.y > 9) return;
  cursor = null; activate(xy(p));
});
el('board').addEventListener('keydown', event => {
  if (event.key === 'Escape') { selected = null; cursor = null; renderBoard(); return; }
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault(); let p = xy(cursor ?? selected ?? { x: 4, y: state.human === 1 ? 6 : 3 });
    p.x = Math.max(0, Math.min(8, p.x + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0)));
    p.y = Math.max(0, Math.min(9, p.y + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0))); cursor = xy(p); renderBoard();
  } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(cursor ?? selected ?? { x: 4, y: state.human === 1 ? 6 : 3 }); }
});
new ResizeObserver(entries => {
  const r = entries[0].contentRect; el('board').style.width = `${Math.max(0, Math.min(r.width - 18, (r.height - 12) * .9))}px`;
  const size = el('board').getBoundingClientRect().width; el('board').style.setProperty('font-size', `${size * .064}px`);
}).observe(el('board-stage'));
button('flip').onclick = () => { flipped = !flipped; staticBoard(); renderBoard(); };
button('hints').onclick = () => { hints = !hints; button('hints').setAttribute('aria-pressed', String(hints)); renderBoard(); };
button('animation').setAttribute('aria-pressed', String(animations)); text('animation', animations ? '✧ 动画开' : '✧ 动画关');
button('animation').onclick = () => { animations = !animations; button('animation').setAttribute('aria-pressed', String(animations)); text('animation', animations ? '✧ 动画开' : '✧ 动画关'); renderBoard(); };
button('live').onclick = () => review(null); input('replay').oninput = () => review(Number(input('replay').value));
button('back').onclick = () => review(Math.max(0, (view ?? state.position.moves.length) - 1));
button('forward').onclick = () => review(Math.min(state.position.moves.length, (view ?? state.position.moves.length) + 1));
button('retry').onclick = () => { void command({ type: 'retry' }); };
button('cancel').onclick = () => { void command({ type: 'cancel' }); };
button('undo').onclick = () => { view = null; void command({ type: 'undo' }); };
button('next-round').onclick = () => { void command({ type: 'next-round' }); };
let confirmation: (() => void) | undefined;
button('resign').onclick = () => { text('confirm-title', '确认本局认输？'); text('confirm-text', '本局将判大模型获胜，比赛比分会随之更新。'); confirmation = () => { void command({ type: 'resign' }); }; dialog('confirm-dialog').showModal(); };
button('confirm-no').onclick = () => dialog('confirm-dialog').close();
button('confirm-yes').onclick = () => { dialog('confirm-dialog').close(); confirmation?.(); confirmation = undefined; };
button('new-game').onclick = () => {
  const s = state.match.settings; select('best-of').value = String(s.bestOf); select('time-control').value = s.timeControl;
  input('main-minutes').value = String(s.mainTimeMs / 60000); input('increment-seconds').value = String(s.incrementMs / 1000); input('allow-undo').checked = s.allowUndo;
  input('increment-seconds').disabled = s.timeControl === 'absolute';
  document.querySelector<HTMLInputElement>(`input[name=color][value="${state.human}"]`)!.checked = true;
  dialog('new-dialog').showModal();
};
button('settings-cancel').onclick = () => dialog('new-dialog').close();
select('time-control').onchange = () => { input('increment-seconds').disabled = select('time-control').value === 'absolute'; };
el<HTMLFormElement>('settings-form').onsubmit = async event => {
  event.preventDefault();
  const ok = await command({ type: 'new', human: Number(document.querySelector<HTMLInputElement>('input[name=color]:checked')!.value) as Color,
    settings: { bestOf: Number(select('best-of').value) as 3 | 5, timeControl: select('time-control').value as 'fischer' | 'absolute',
      mainTimeMs: Math.round(Number(input('main-minutes').value) * 60000), incrementMs: Math.round(Number(input('increment-seconds').value) * 1000), allowUndo: input('allow-undo').checked } });
  if (ok) dialog('new-dialog').close();
};
select('model').onchange = () => { const m = models.find(m => `${m.provider}/${m.id}` === select('model').value); if (m) void command({ type: 'model', provider: m.provider, id: m.id }); };
button('export').onclick = async () => { const r = await window.chess.exportRecord(); if (!r.ok) toast(r.error); else if (r.value) toast(`已导出：${r.value}`); };
button('expert-open').onclick = () => { if (state) { renderExpert(); dialog('expert-dialog').showModal(); el('expert-title').focus({ preventScroll: true }); dialog('expert-dialog').scrollTop = 0; } };
button('expert-close').onclick = () => dialog('expert-dialog').close();
button('layers-toggle').onclick = () => { el('layers').hidden = !el('layers').hidden; renderLogs(); };
button('layers-close').onclick = () => { el('layers').hidden = true; };
audio.subscribe(s => { button('music').setAttribute('aria-pressed', String(s.playing)); button('music').disabled = s.busy; select('music-style').disabled = s.busy; text('music', s.playing ? '♫ 暂停配乐' : '♫ 播放配乐'); if (s.error) toast(s.error); });
button('music').onclick = () => { void audio.toggle().catch(() => {}); };
select('music-style').onchange = () => { void audio.setStyle(select('music-style').value as MusicStyle).catch(() => {}); };
input('volume').oninput = () => audio.setVolume(Number(input('volume').value) / 100);
button('music-credits').onclick = () => dialog('music-dialog').showModal(); button('music-close').onclick = () => dialog('music-dialog').close();
window.addEventListener('beforeunload', () => audio.dispose());
async function bootstrap() {
  const r = await window.chess.bootstrap();
  if (!r.ok) { toast(r.error); return; }
  models = r.value.models;
  const empty = document.createElement('option'); empty.value = ''; empty.textContent = '请选择已认证模型'; select('model').append(empty);
  for (const m of models) { const o = document.createElement('option'); o.value = `${m.provider}/${m.id}`; o.textContent = `${m.name} · ${m.provider}/${m.id}`; select('model').append(o); }
  receive(r.value.state); if (r.value.setupError) toast(r.value.setupError);
  window.chess.onState(receive);
  setupLearningUI(window.chess, r.value.learning, () => state.id);
}
void bootstrap().catch(error => toast(String(error)));
