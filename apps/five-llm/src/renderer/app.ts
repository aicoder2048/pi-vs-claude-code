import { coordinate, index, replay, SIZE, type Point } from '../business/engine';
import type { Command, GameState, Reply, ResultReason } from '../shared/types';
import { Ambience } from './audio';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('board'), ctx = canvas.getContext('2d')!;
const audio = new Ambience($<HTMLAudioElement>('background-music'));
let state: GameState | undefined;
let showNumbers = true, showHints = false, pending = false, viewing: number | null = null;
let hover: Point | null = null, keyboard: Point = { x: 7, y: 7 }, useKeyboard = false;
let setupError: string | null = null, toastTimer: ReturnType<typeof setTimeout>;
const SIZE_PX = 760, PAD = 52, STEP = (SIZE_PX - 2 * PAD) / 14;
function toast(text: string): void {
  $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function unwrap<T>(reply: Reply<T>): T { if (!reply.ok) throw new Error(reply.error); return reply.value; }
async function command(value: Command): Promise<void> {
  if (pending) return;
  pending = true;
  try { apply(unwrap(await window.five.command(value))); }
  catch (error) { toast(error instanceof Error ? error.message : String(error)); }
  finally { pending = false; }
}
function apply(next: GameState): void {
  const previous = state;
  if (previous && previous.id === next.id && next.revision < previous.revision) return;
  if (previous && previous.id !== next.id) viewing = null;
  if (viewing !== null && viewing > next.position.moves.length) viewing = next.position.moves.length;
  state = next;
  if (previous && previous.id === next.id && previous.revision === next.revision && previous.status === next.status
    && previous.error === next.error && previous.logs.at(-1)?.text === next.logs.at(-1)?.text
    && previous.logs.at(-1)?.time === next.logs.at(-1)?.time) {
    renderClocks(); return; // heartbeat must not rebuild all history, logs and canvas at 5Hz
  }
  if (previous && previous.id === next.id && next.position.moves.length > previous.position.moves.length) void audio.stone().catch(() => {});
  render();
}
function position() { return viewing === null ? state!.position : replay(state!.position.moves.slice(0, viewing)); }
const resultLabels: Record<ResultReason, string> = { five: '连五获胜', draw: '和棋', 'main-time': '包干局时耗尽', byoyomi: '最后一次读秒耗尽', resign: '认输' };
function timeText(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function renderClocks(): void {
  if (!state) return;
  const { clock, match, human } = state, settings = match.settings;
  $('clock-rule').textContent = settings.timeControl === 'byoyomi'
    ? `${settings.mainTimeMs / 60000} 分钟 + ${settings.periods} × ${settings.periodTimeMs / 1000} 秒`
    : `每方 ${settings.mainTimeMs / 60000} 分钟包干`;
  for (const [prefix, color] of [['human', human], ['machine', human === 1 ? 2 : 1]] as const) {
    const player = clock.players[color], overtime = settings.timeControl === 'byoyomi' && player.mainMs <= 0;
    const left = overtime ? player.periodMs : player.mainMs;
    $(`${prefix}-time`).textContent = timeText(left);
    $(`${prefix}-clock-phase`).textContent = overtime ? '每步读秒' : '基本用时';
    $(`${prefix}-periods`).textContent = settings.timeControl === 'absolute' ? '总时耗尽即负'
      : `${overtime ? '余' : '读秒'} ${player.periodsLeft} × ${settings.periodTimeMs / 1000}s${overtime ? ' · 落子重置秒数' : ''}`;
    $(`${prefix}-clock`).classList.toggle('active', clock.running === color);
    $(`${prefix}-clock`).classList.toggle('low', clock.running === color && left <= 10000 && (overtime || settings.timeControl === 'absolute'));
  }
  $('clock-turn').textContent = clock.running === null ? '本局结束 · 棋钟停止'
    : `${clock.running === human ? '你' : 'LLM'}本手用时 ${Math.floor(clock.turnElapsedMs / 1000)}s · ${viewing !== null ? '回看不停钟' : '仅计行棋方'}`;
}
function stone(x: number, y: number, color: 1 | 2, number?: number, ghost = false): void {
  const px = PAD + x * STEP, py = PAD + y * STEP, r = STEP * .448;
  ctx.save(); ctx.globalAlpha = ghost ? .35 : 1;
  ctx.shadowColor = '#33241566'; ctx.shadowBlur = ghost ? 0 : 5; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 3;
  const gradient = ctx.createRadialGradient(px - r * .35, py - r * .4, 1, px, py, r);
  if (color === 1) { gradient.addColorStop(0, '#5a5b54'); gradient.addColorStop(.55, '#282a25'); gradient.addColorStop(1, '#11130f'); }
  else { gradient.addColorStop(0, '#fffef7'); gradient.addColorStop(.65, '#f0eee2'); gradient.addColorStop(1, '#cfccbc'); }
  ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
  ctx.shadowColor = 'transparent';
  if (number !== undefined) {
    ctx.fillStyle = color === 1 ? '#eeeada' : '#6b685b'; ctx.font = `500 ${number >= 100 ? 13 : 15}px -apple-system, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(number), px, py + 1);
  }
  ctx.restore();
}
function lastMoveHalo(point: Point): void {
  const px = PAD + point.x * STEP, py = PAD + point.y * STEP;
  const r = STEP * .448, outer = r + 12;
  ctx.save();
  // A persistent halo, not a timed flash: still visible after a long LLM turn.
  // Leave the stone itself transparent so its color and move number stay legible.
  const glow = ctx.createRadialGradient(px, py, r, px, py, outer);
  glow.addColorStop(0, '#19cbdab0'); glow.addColorStop(.45, '#19cbda60'); glow.addColorStop(1, '#19cbda00');
  ctx.fillStyle = glow; ctx.beginPath();
  ctx.arc(px, py, outer, 0, Math.PI * 2); ctx.arc(px, py, r, 0, Math.PI * 2, true); ctx.fill();
  // Light separation plus a saturated outline work on both black and white stones.
  ctx.strokeStyle = '#f0ffff'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(px, py, r + 3, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#087f8c'; ctx.lineWidth = 3;
  ctx.shadowColor = '#19cbda'; ctx.shadowBlur = 8;
  ctx.stroke(); ctx.restore();
}
function draw(): void {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * dpr);
  if (canvas.width !== width) { canvas.width = width; canvas.height = width; }
  ctx.setTransform(width / SIZE_PX, 0, 0, width / SIZE_PX, 0, 0);
  const wood = ctx.createLinearGradient(0, 0, SIZE_PX, SIZE_PX);
  wood.addColorStop(0, '#dfbb7d'); wood.addColorStop(.45, '#d5aa69'); wood.addColorStop(1, '#cda263');
  ctx.fillStyle = wood; ctx.fillRect(0, 0, SIZE_PX, SIZE_PX);
  // Deterministic, fine woodgrain rather than a downloaded texture.
  for (let i = 0; i < 450; i++) {
    const y = (i * 1.713) % SIZE_PX;
    ctx.strokeStyle = i % 3 === 0 ? '#795c3020' : '#fce2ad18'; ctx.lineWidth = i % 4 === 0 ? 1.4 : .5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.bezierCurveTo(200, y + Math.sin(i) * 4, 500, y - 3, SIZE_PX, y + Math.cos(i) * 2); ctx.stroke();
  }
  ctx.strokeStyle = '#624c309c'; ctx.lineWidth = 1;
  for (let i = 0; i < SIZE; i++) {
    const n = PAD + i * STEP;
    ctx.beginPath(); ctx.moveTo(PAD, n); ctx.lineTo(SIZE_PX - PAD, n); ctx.moveTo(n, PAD); ctx.lineTo(n, SIZE_PX - PAD); ctx.stroke();
  }
  ctx.strokeStyle = '#624c30b0'; ctx.lineWidth = 1.7; ctx.strokeRect(PAD, PAD, SIZE_PX - PAD * 2, SIZE_PX - PAD * 2);
  ctx.fillStyle = '#6a5133'; ctx.font = '12px Georgia, serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let i = 0; i < SIZE; i++) {
    ctx.fillText(String.fromCharCode(65 + i), PAD + i * STEP, 26); ctx.fillText(String.fromCharCode(65 + i), PAD + i * STEP, SIZE_PX - 24);
    ctx.fillText(String(15 - i), 25, PAD + i * STEP); ctx.fillText(String(15 - i), SIZE_PX - 24, PAD + i * STEP);
  }
  for (const [x, y] of [[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]]) {
    ctx.beginPath(); ctx.arc(PAD + x * STEP, PAD + y * STEP, x === 7 ? 3.8 : 3.3, 0, Math.PI * 2); ctx.fill();
  }
  if (!state) return;
  const p = position();
  p.moves.forEach((move, i) => stone(move.x, move.y, move.color, showNumbers ? i + 1 : undefined));
  const last = p.moves.at(-1);
  if (last) lastMoveHalo(last);
  if (p.winningLine.length) {
    for (const point of p.winningLine) {
      ctx.strokeStyle = '#a75839'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(PAD + point.x * STEP, PAD + point.y * STEP, STEP * .36, 0, Math.PI * 2); ctx.stroke();
    }
  }
  if (showHints && viewing === null && !p.winner && !state.outcome) {
    for (const [i, point] of state.analysis.candidates.slice(0, 3).entries()) {
      ctx.fillStyle = '#536850aa'; ctx.beginPath(); ctx.arc(PAD + point.x * STEP, PAD + point.y * STEP, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#f9f3e4'; ctx.font = '10px sans-serif'; ctx.fillText(String(i + 1), PAD + point.x * STEP, PAD + point.y * STEP + .5);
    }
  }
  const selected = useKeyboard ? keyboard : hover;
  if (selected && viewing === null && state.status === 'human' && !p.board[index(selected.x, selected.y)]) stone(selected.x, selected.y, p.next, undefined, true);
  if (useKeyboard) {
    ctx.strokeStyle = '#536850'; ctx.lineWidth = 2;
    ctx.strokeRect(PAD + keyboard.x * STEP - STEP / 2 + 2, PAD + keyboard.y * STEP - STEP / 2 + 2, STEP - 4, STEP - 4);
  }
  const latest = last ? `最近落子：${last.color === state.human ? '你' : 'LLM'} · ${last.color === 1 ? '黑' : '白'} ${coordinate(last)} · 第 ${p.moves.length} 手` : '';
  const caption = latest ? `青色光晕 · ${latest}` : '15 × 15 ／ 自由五子棋 · 连五获胜 · 无禁手';
  if ($('last-move').textContent !== caption) $('last-move').textContent = caption;
  canvas.setAttribute('aria-label', `15 路五子棋，${p.moves.length} 手。${latest ? `${latest}。` : ''}选中 ${coordinate(keyboard)}，${state.status === 'human' ? '回车落子' : '等待机器方'}`);
}
function render(): void {
  if (!state) return;
  const p = position(), historical = viewing !== null;
  const analysis = historical ? state.evaluations[(viewing ?? 0) - 1] : state.analysis;
  const nextName = p.next === 1 ? '黑棋' : '白棋', winner = historical ? p.winner : state.outcome?.winner ?? p.winner;
  const turnColor = winner && winner !== 'draw' ? winner : p.next;
  $('turn-stone').className = `mini-stone ${turnColor === 1 ? 'black' : 'white'}`;
  $('turn-text').textContent = winner ? winner === 'draw' ? '和棋' : `${winner === 1 ? '黑棋' : '白棋'}获胜` : `${nextName}${state.status === 'thinking' && !historical ? '思考中' : '行棋'}`;
  $('ply-text').textContent = winner ? `已落 ${p.moves.length} 手` : `第 ${String(p.moves.length + 1).padStart(2, '0')} 手`;
  const match = state.match, target = Math.ceil(match.settings.bestOf / 2);
  $('match-format').textContent = match.settings.bestOf === 3 ? '三局两胜' : '五局三胜';
  $('round-label').textContent = `第 ${state.outcome?.number ?? match.rounds.length + 1} 盘 · 先胜 ${target} 局${match.draws ? ` · ${match.draws} 和` : ''}`;
  $('human-wins').textContent = String(match.humanWins); $('machine-wins').textContent = String(match.machineWins);
  $('match-result').textContent = match.winner ? match.winner === 'human' ? '比赛结束 · 你获胜' : '比赛结束 · LLM 获胜'
    : match.settings.allowUndo ? '练习模式 · 允许悔棋' : '局间换色 · 和棋重赛';
  $('next-round').hidden = !state.outcome || !!match.winner;
  $('next-round').textContent = state.outcome?.winner === 'draw' ? '和棋重赛 →' : '下一局 →';
  $('new-game').classList.toggle('primary', !!match.winner);
  $<HTMLButtonElement>('resign').disabled = !!state.outcome;
  renderClocks();
  $('board-mode').textContent = historical ? `REPLAY / ${viewing}` : state.outcome ? 'ROUND COMPLETE' : 'LIVE GAME';
  $('human-chip').className = `mini-stone ${state.human === 1 ? 'black' : 'white'}`;
  for (const id of ['machine-chip', 'ai-stone']) $(id).className = `mini-stone ${state.human === 1 ? 'white' : 'black'}`;
  $('human-color').textContent = state.human === 1 ? '执黑 · 先手' : '执白 · 后手';
  $('machine-color').textContent = state.human === 1 ? '执白 · 后手' : '执黑 · 先手';
  const status = historical ? 'replay' : state.status;
  const labels: Record<string, [string, string, string]> = {
    human: ['轮到你了', p.moves.length ? '不急，下一手由你' : '从天元开始，也很好', '点击交叉点落子。每一手都会由业务层重新计算。'],
    thinking: ['正在思考', 'π 正在斟酌下一手', '完整棋谱 → 计算 → Pi 扩展 → LLM → 校验落子'],
    paused: ['请求已停止', '棋钟仍在走，请及时继续', '停止的只是模型请求，不是比赛时间。重试不会返还读秒。'],
    error: ['等待重试', '请求未完成，棋钟继续', '不会以传统 AI 代下。网络重试与请求耗时计入模型用时。'],
    over: [match.winner ? '比赛结束' : '本局结束', match.winner ? match.winner === 'human' ? '恭喜，赢下本场比赛' : '比赛终了，再接再厉'
      : winner === 'draw' ? '棋逢对手，和棋重赛' : winner === state.human ? '好棋，你赢了这一局' : '一局终了，亦有所得',
      `${state.outcome ? resultLabels[state.outcome.reason] : ''} · 你 ${match.humanWins} : ${match.machineWins} LLM。${match.winner ? '可以开始新比赛。' : winner === 'draw' ? '同色重赛，不计胜场。' : '下一局交换黑白，时钟重新分配。'}`],
    replay: ['棋谱回看', `回到第 ${viewing} 手`, '回看期间不可落子。返回实战后继续当前对局。'],
  };
  const [badge, title, description] = labels[status];
  $('status-badge').textContent = badge; $('status-title').textContent = title; $('status-description').textContent = description;
  $('status-icon').textContent = status === 'thinking' ? '◌' : status === 'over' ? '✧' : '○';
  $('status-icon').classList.toggle('thinking', status === 'thinking');
  const error = state.error || setupError;
  $('error').hidden = !error; $('error').textContent = error;
  $('retry').hidden = historical || !['error', 'paused'].includes(state.status);
  $('cancel').hidden = state.status !== 'thinking';
  $<HTMLButtonElement>('undo').disabled = !state.position.moves.length || !match.settings.allowUndo || !!state.outcome;
  $('undo').title = match.settings.allowUndo ? '练习悔棋不返还已耗时间，已结算局不可悔棋' : '正式比赛不允许悔棋；可在新比赛设置中开启练习悔棋';
  const selected = state.model ? `${state.model.provider}/${state.model.id}` : '';
  $<HTMLSelectElement>('model').value = selected;
  const note = state.notes.filter(n => n.ply <= p.moves.length).at(-1);
  $('reason').hidden = !note;
  if (note) { $('reason-text').textContent = note.reason; $('reason-meta').textContent = `第 ${note.ply} 手 · ${(note.elapsedMs / 1000).toFixed(1)}s · ${note.model}`; }
  $('analysis-text').textContent = analysis?.summary ?? '开局布局，争取中腹与连线空间';
  const b = analysis?.blackScore ?? 0, w = analysis?.whiteScore ?? 0;
  $('black-score').textContent = `黑 ${b.toLocaleString()}`; $('white-score').textContent = `白 ${w.toLocaleString()}`;
  $('score-fill').style.width = `${50 + Math.tanh((b - w) / 6000) * 40}%`;
  $('record-count').textContent = `${state.position.moves.length} MOVES`;
  $('empty-record').hidden = state.position.moves.length > 0;
  const moves = $('moves'), lastCount = moves.childElementCount;
  moves.replaceChildren(...state.position.moves.map((move, i) => {
    const li = document.createElement('li'), button = document.createElement('button');
    button.classList.toggle('selected', p.moves.length === i + 1);
    button.setAttribute('aria-label', `第 ${i + 1} 手 ${move.color === 1 ? '黑' : '白'} ${coordinate(move)}`);
    const num = document.createElement('small'); num.textContent = String(i + 1);
    const chip = document.createElement('span'); chip.className = `mini-stone ${move.color === 1 ? 'black' : 'white'}`;
    const text = document.createTextNode(coordinate(move)); button.append(num, chip, text);
    button.onclick = () => { viewing = i + 1; render(); }; li.append(button); return li;
  }));
  if (lastCount !== state.position.moves.length && !historical) moves.scrollTop = moves.scrollHeight;
  const slider = $<HTMLInputElement>('replay'); slider.max = String(state.position.moves.length); slider.value = String(p.moves.length);
  $('replay-ply').textContent = `${p.moves.length} / ${state.position.moves.length}`;
  $('logs').replaceChildren(...state.logs.slice(-24).map(log => {
    const li = document.createElement('li'); li.textContent = `${new Date(log.time).toLocaleTimeString()} [${log.layer}] ${log.text}`; return li;
  }));
  draw();
}
function eventPoint(event: MouseEvent): Point | null {
  const rect = canvas.getBoundingClientRect();
  const fx = ((event.clientX - rect.left) * SIZE_PX / rect.width - PAD) / STEP;
  const fy = ((event.clientY - rect.top) * SIZE_PX / rect.height - PAD) / STEP;
  const x = Math.round(fx), y = Math.round(fy);
  return x >= 0 && y >= 0 && x < SIZE && y < SIZE && Math.abs(fx - x) <= .48 && Math.abs(fy - y) <= .48 ? { x, y } : null;
}
function move(point: Point): void {
  if (!state || pending) return;
  if (viewing !== null) { toast('正在回看棋谱，请先返回实战'); return; }
  if (state.status !== 'human') return;
  void command({ type: 'move', ...point, revision: state.revision });
}
canvas.addEventListener('mousemove', event => { hover = eventPoint(event); useKeyboard = false; draw(); });
canvas.addEventListener('mouseleave', () => { hover = null; draw(); });
canvas.addEventListener('click', event => { const point = eventPoint(event); if (point) { keyboard = point; move(point); } });
canvas.addEventListener('keydown', event => {
  const arrows: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
  if (event.key in arrows) {
    event.preventDefault(); useKeyboard = true;
    keyboard = { x: Math.max(0, Math.min(14, keyboard.x + arrows[event.key].x)), y: Math.max(0, Math.min(14, keyboard.y + arrows[event.key].y)) }; draw();
  } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); useKeyboard = true; move(keyboard); }
});
$('numbers').onclick = () => { showNumbers = !showNumbers; $('numbers').classList.toggle('active', showNumbers); $('numbers').setAttribute('aria-pressed', String(showNumbers)); draw(); };
$('hints').onclick = () => { showHints = !showHints; $('hints').classList.toggle('active', showHints); $('hints').setAttribute('aria-pressed', String(showHints)); draw(); };
$('undo').onclick = () => { viewing = null; void command({ type: 'undo' }); };
$('retry').onclick = () => { viewing = null; void command({ type: 'retry' }); };
$('cancel').onclick = () => { void command({ type: 'cancel' }); };
const newDialog = $<HTMLDialogElement>('new-dialog');
function updateTimeSettings(): void {
  const byoyomi = $<HTMLSelectElement>('time-control').value === 'byoyomi';
  document.querySelectorAll<HTMLElement>('.byoyomi-setting').forEach(element => { element.hidden = !byoyomi; });
  for (const id of ['period-seconds', 'period-count']) $<HTMLInputElement>(id).disabled = !byoyomi;
  $<HTMLInputElement>('main-minutes').min = byoyomi ? '0' : '1';
  $('time-rule-note').textContent = byoyomi
    ? '基本用时耗尽后进入读秒；每次读秒超时扣一次，最后一次用尽判本局负。按时落子重置本步秒数，不返还已扣次数。基本用时阶段没有独立步时上限。'
    : '每方独立累计本局用时，轮到对手时停表；自己的总时耗尽直接判本局负。不另设每步上限，也不额外赠送读秒。';
}
$<HTMLSelectElement>('time-control').onchange = updateTimeSettings;
$('new-game').onclick = () => {
  if (state) {
    const settings = state.match.settings;
    $<HTMLSelectElement>('best-of').value = String(settings.bestOf);
    $<HTMLSelectElement>('time-control').value = settings.timeControl;
    $<HTMLInputElement>('main-minutes').value = String(settings.mainTimeMs / 60000);
    $<HTMLInputElement>('period-seconds').value = String(settings.periodTimeMs / 1000);
    $<HTMLInputElement>('period-count').value = String(settings.periods);
    $<HTMLInputElement>('allow-undo').checked = settings.allowUndo;
  }
  updateTimeSettings(); newDialog.returnValue = ''; newDialog.showModal();
};
newDialog.addEventListener('close', () => {
  if (newDialog.returnValue === 'start') {
    viewing = null;
    const values = new FormData(newDialog.querySelector('form')!);
    void command({ type: 'new', human: values.get('color') === '2' ? 2 : 1, settings: {
      bestOf: values.get('bestOf') === '5' ? 5 : 3,
      timeControl: values.get('timeControl') === 'absolute' ? 'absolute' : 'byoyomi',
      mainTimeMs: Number(values.get('mainMinutes')) * 60000,
      periodTimeMs: Number($<HTMLInputElement>('period-seconds').value) * 1000,
      periods: Number($<HTMLInputElement>('period-count').value), allowUndo: values.has('allowUndo'),
    } });
  }
});
$('next-round').onclick = () => { viewing = null; void command({ type: 'next-round' }); };
const resignDialog = $<HTMLDialogElement>('resign-dialog');
$('resign').onclick = () => { resignDialog.returnValue = ''; resignDialog.showModal(); };
resignDialog.addEventListener('close', () => { if (resignDialog.returnValue === 'resign') void command({ type: 'resign' }); });
$<HTMLSelectElement>('model').onchange = event => {
  const value = (event.target as HTMLSelectElement).value, slash = value.indexOf('/');
  if (slash < 0) return;
  setupError = null; void command({ type: 'model', provider: value.slice(0, slash), id: value.slice(slash + 1) });
};
$('export').onclick = async () => { try { const file = unwrap(await window.five.exportRecord()); if (file) toast(`棋谱已保存：${file}`); } catch (e) { toast(String(e)); } };
$<HTMLInputElement>('replay').oninput = event => { viewing = Number((event.target as HTMLInputElement).value); render(); };
$('live').onclick = () => { viewing = null; render(); };
let lastMusicError: string | null = null;
const unsubscribeAudio = audio.subscribe(music => {
  $('music').setAttribute('aria-pressed', String(music.playing));
  $('music').setAttribute('aria-label', music.playing ? '暂停背景音乐' : '播放背景音乐');
  $<HTMLButtonElement>('music').disabled = music.busy;
  $<HTMLSelectElement>('music-style').disabled = music.busy;
  $<HTMLSelectElement>('music-style').value = music.style;
  $('music-status').textContent = music.error ? '播放失败 · 点击重试'
    : music.busy && !music.playing ? '正在载入本地录音…' : music.playing ? '正在播放 · 本地录音' : '点击播放 · 本地录音';
  if (music.error && music.error !== lastMusicError) toast(music.error);
  lastMusicError = music.error;
});
$('music').onclick = () => { void audio.toggle().catch(() => {}); };
$<HTMLSelectElement>('music-style').onchange = event => { void audio.setStyle((event.target as HTMLSelectElement).value === 'jazz' ? 'jazz' : 'piano').catch(() => {}); };
const musicDialog = $<HTMLDialogElement>('music-dialog');
$('music-credits').onclick = () => musicDialog.showModal();
$<HTMLInputElement>('volume').oninput = event => audio.setVolume(Number((event.target as HTMLInputElement).value) / 100);
const observer = new ResizeObserver(() => draw()); observer.observe(canvas);
const unsubscribe = window.five.onState(apply);
window.addEventListener('beforeunload', () => { unsubscribe(); unsubscribeAudio(); observer.disconnect(); audio.dispose(); });
try {
  const initial = unwrap(await window.five.bootstrap()); setupError = initial.setupError;
  const select = $<HTMLSelectElement>('model'); select.replaceChildren();
  if (!initial.state.model) {
    const option = document.createElement('option'); option.value = '';
    option.textContent = initial.models.length ? 'gpt-6.1-sol 不可用 · 请手动选择' : '未配置模型 · 请先在 Pi 中登录';
    option.disabled = true; select.append(option); select.disabled = !initial.models.length;
  }
  for (const model of initial.models) {
    const option = document.createElement('option'); option.value = `${model.provider}/${model.id}`; option.textContent = `${model.provider} / ${model.name}`; select.append(option);
  }
  apply(initial.state);
} catch (error) { $('error').hidden = false; $('error').textContent = `桌面连接失败：${String(error)}`; }
