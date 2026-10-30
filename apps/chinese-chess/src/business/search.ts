import { at, inCheck, index, legalCaptures, legalMoves, other, play, same, VALUES, type Color, type MoveInput, type Position } from './engine';
import { phaseOf, pieceValue, type Phase } from './expert';
import { evaluatePosition } from './evaluation';
export const MATE_SCORE = 1000000;
const INF = MATE_SCORE * 2;
export interface SearchOptions { maxMs?: number; maxNodes?: number; maxDepth?: number; quiescenceDepth?: number; extensions?: number; moves?: MoveInput[]; signal?: AbortSignal }
export interface SearchCandidate { move: MoveInput; score: number; pv: MoveInput[]; line: string[] }
export interface SearchReport {
  version: 'xiangqi-search/v1'; perspective: Color; completedDepth: number; attemptedDepth: number;
  stopped: 'depth' | 'time' | 'nodes' | 'cancelled' | 'terminal'; nodes: number; elapsedMs: number;
  legalRoots: number; searchedRoots: number; rootScope: 'all-legal' | 'requested-subset';
  bestMove: MoveInput | null; candidates: SearchCandidate[]; rootScores: { move: MoveInput; score: number }[];
  qNodes: number; horizonCuts: number; maxPly: number; limitations: string[];
}
export interface SearchDriver { search(position: Position, options: SearchOptions, signal: AbortSignal): Promise<SearchReport> }
const sameMove = (a: MoveInput, b: MoveInput) => same(a.from, b.from) && same(a.to, b.to);
const copy = (m: MoveInput): MoveInput => ({ from: { ...m.from }, to: { ...m.to } });
export function staticScore(p: Position, perspective = p.next, phase: Phase = phaseOf(p)): number {
  let score = 0;
  for (const x of p.board) {
    if (!x) continue;
    const value = pieceValue(x, phase);
    score += x.color === perspective ? value : -value;
  }
  score += evaluatePosition(p, perspective, phase).total - evaluatePosition(p, other(perspective), phase).total;
  // No positional heuristic is ever allowed to masquerade as a mate score.
  return Math.max(-50000, Math.min(50000, score));
}
class Stop extends Error { constructor(public reason: SearchReport['stopped']) { super(reason); } }
interface Value { score: number; pv: MoveInput[] }
export function searchPosition(position: Position, options: SearchOptions = {}): SearchReport {
  const began = performance.now(), deadline = began + Math.max(0, Math.min(3000, options.maxMs ?? 400));
  const limit = Math.max(0, Math.min(100000, options.maxNodes ?? 12000));
  const maxDepth = Math.max(1, Math.min(8, options.maxDepth ?? 5)), qDepth = Math.max(0, Math.min(8, options.quiescenceDepth ?? 4));
  const extensionLimit = Math.max(0, Math.min(3, options.extensions ?? 2)), phase = phaseOf(position);
  const all = legalMoves(position);
  if (options.moves && (options.moves.length < 1 || options.moves.length > 6)) throw new Error('搜索候选须为 1–6 个');
  const roots = options.moves ? options.moves.map(m => { const legal = all.find(x => sameMove(x, m)); if (!legal) throw new Error('搜索候选不是当前合法走法'); return legal; }).filter((m, i, xs) => xs.findIndex(x => sameMove(x, m)) === i) : all;
  const report: SearchReport = { version: 'xiangqi-search/v1', perspective: position.next, completedDepth: 0, attemptedDepth: 0, stopped: position.winner ? 'terminal' : 'depth',
    nodes: 0, elapsedMs: 0, legalRoots: all.length, searchedRoots: roots.length, rootScope: options.moves ? 'requested-subset' : 'all-legal', bestMove: null, candidates: [], rootScores: [], qNodes: 0, horizonCuts: 0, maxPly: 0,
    limitations: ['分数是当前搜索范围/深度的局面估计，不是胜率或完备求解。', '只采用最后完整迭代；预算截断不把未完成的根节点当成安全结论。', '静态搜索延伸吃子与合法应将，仍有地平线；不使用跨不同重复历史的置换表。'] };
  const killers = new Map<number, MoveInput[]>(), history = new Map<string, number>();
  function enter(ply: number) {
    if (options.signal?.aborted) throw new Stop('cancelled');
    if (report.nodes >= limit) throw new Stop('nodes');
    if (performance.now() >= deadline) throw new Stop('time');
    report.nodes++; report.maxPly = Math.max(report.maxPly, ply);
  }
  function terminal(p: Position, ply: number): number | null {
    if (!p.winner) return null;
    return p.winner === 'draw' ? 0 : p.winner === p.next ? MATE_SCORE - ply : -MATE_SCORE + ply;
  }
  function order(p: Position, moves: MoveInput[], ply: number, preferred?: MoveInput): MoveInput[] {
    return moves.map(m => {
      const target = at(p.board, m.to), piece = at(p.board, m.from)!;
      const score = preferred && sameMove(preferred, m) ? 10000000 : target ? VALUES[target.kind] * 100 - VALUES[piece.kind] : (killers.get(ply)?.some(k => sameMove(k, m)) ? 8000 : 0) + (history.get(`${p.next}/${index(m.from)}/${index(m.to)}`) ?? 0);
      return { m, score };
    }).sort((a, b) => b.score - a.score).map(x => x.m);
  }
  function quiet(p: Position, alpha: number, beta: number, left: number, ply: number): Value {
    enter(ply); report.qNodes++;
    const end = terminal(p, ply); if (end !== null) return { score: end, pv: [] };
    const checked = inCheck(p.board, p.next);
    let best: Value = { score: checked ? -INF : staticScore(p, p.next, phase), pv: [] };
    if (!checked) {
      if (best.score >= beta || left <= 0) return best;
      alpha = Math.max(alpha, best.score);
    }
    // In check there is no stand-pat: even at the q horizon, examine each
    // legal evasion once. Boundary heuristics remain strictly below mate scores.
    const moves = order(p, checked ? legalMoves(p) : legalCaptures(p), ply);
    if (!moves.length) return checked ? { score: -MATE_SCORE + ply, pv: [] } : best;
    for (const m of moves) {
      const q = play(p, m);
      let result: Value;
      if (left <= 0 || ply >= 30) {
        enter(ply + 1); report.horizonCuts++;
        const value = terminal(q, ply + 1);
        result = { score: value ?? staticScore(q, q.next, phase), pv: [] };
      } else result = quiet(q, -beta, -alpha, left - 1, ply + 1);
      const score = -result.score;
      if (score > best.score) best = { score, pv: [copy(m), ...result.pv] };
      alpha = Math.max(alpha, score); if (alpha >= beta) break;
    }
    return best;
  }
  function negamax(p: Position, depth: number, alpha: number, beta: number, ply: number, extensions: number): Value {
    enter(ply);
    const end = terminal(p, ply); if (end !== null) return { score: end, pv: [] };
    const checked = inCheck(p.board, p.next);
    if (checked && extensions > 0) { depth++; extensions--; }
    if (depth <= 0 || ply >= 24) return quiet(p, alpha, beta, qDepth, ply);
    const moves = order(p, legalMoves(p), ply);
    if (!moves.length) return { score: -MATE_SCORE + ply, pv: [] }; // Xiangqi stalemate is loss
    if (moves.length === 1 && extensions > 0) { depth++; extensions--; }
    let best: Value = { score: -INF, pv: [] };
    for (const m of moves) {
      const q = play(p, m), result = negamax(q, depth - 1, -beta, -alpha, ply + 1, extensions);
      const score = -result.score;
      if (score > best.score) best = { score, pv: [copy(m), ...result.pv] };
      alpha = Math.max(alpha, score);
      if (alpha >= beta) {
        if (!at(p.board, m.to)) {
          killers.set(ply, [m, ...(killers.get(ply) ?? [])].slice(0, 2));
          const key = `${p.next}/${index(m.from)}/${index(m.to)}`; history.set(key, Math.min(5000, (history.get(key) ?? 0) + depth * depth));
        }
        break;
      }
    }
    return best;
  }
  if (!position.winner && roots.length) {
    let previous = roots.slice();
    try {
      for (let depth = 1; depth <= maxDepth; depth++) {
        report.attemptedDepth = depth;
        const iteration: SearchCandidate[] = [];
        for (const move of previous) {
          enter(0);
          const q = play(position, move), v = negamax(q, depth - 1, -INF, INF, 1, extensionLimit);
          const pv = [copy(move), ...v.pv], line: string[] = []; let replay = position;
          for (const step of pv) { replay = play(replay, step); line.push(replay.moves.at(-1)!.notation); }
          // Independent full windows make every root score comparable, rather
          // than presenting alpha/beta bounds as exact candidate evaluations.
          iteration.push({ move: copy(move), score: -v.score, pv, line });
        }
        iteration.sort((a, b) => b.score - a.score);
        report.completedDepth = depth; report.bestMove = iteration[0].move;
        report.candidates = iteration.slice(0, 8); report.rootScores = iteration.map(x => ({ move: x.move, score: x.score }));
        previous = iteration.map(x => x.move);
      }
    } catch (e) { if (e instanceof Stop) report.stopped = e.reason; else throw e; }
  }
  report.elapsedMs = performance.now() - began;
  return report;
}
export function searchSupportsWin(p: Position, move: MoveInput, report?: SearchReport): boolean {
  if (!report || report.completedDepth === 0 || report.stopped === 'cancelled' || report.perspective !== p.next) return false;
  const found = report.candidates.find(x => sameMove(x.move, move));
  if (!found || found.score < MATE_SCORE - 100 || !found.pv.length) return false;
  try { let q = p; for (const step of found.pv) q = play(q, step); return q.winner === p.next; } catch { return false; }
}
