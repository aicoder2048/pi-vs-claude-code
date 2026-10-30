import {
  analyze, at, colorName, controlsSquare, coordinate, glyph, inCheck, index, legalCapturesTo, legalMoves,
  other, play, same, VALUES, type Analysis, type Color, type MoveInput, type Piece, type Point, type Position,
} from './engine';

import type { SearchReport } from './search';
import type { ExperienceHint } from './learning';
import type { KnowledgeHint } from './knowledge';
// Business-owned, bounded tactical assistance, NOT a substitute chess player.
// Every reported line uses legal moves. Exchange scores intentionally ignore
// off-square tactics and are labelled estimates, never a proof of forced loss.
export type Phase = 'opening' | 'middlegame' | 'endgame';
export type Risk = 'win' | 'loss' | 'material-loss' | 'exchange-risk' | 'uncertain' | 'no-direct-loss-found';
export interface PieceSafety {
  piece: string; id: string; color: Color; square: Point; value: number;
  legalAttackers: string[]; geometricDefenders: string[]; pinnedToKing: boolean;
  loose: boolean; // attacked with NO geometric support, not a forced-loss claim
}
export interface Principle { id: string; title: string; advice: string; evidence: string[] }
export interface Formation {
  advisors: number; elephants: number; legalKingExits: number;
  undevelopedMajors: string[];
  horseMobility: { piece: string; destinations: number }[];
}
export interface MoveReview {
  move: MoveInput; notation: string; risk: Risk; score: number;
  immediateGain: number; estimatedNet: number; positionalDelta: number;
  bestReply: MoveInput | null; line: string[]; variation: MoveInput[];
  terminal: { winner: Color | 'draw'; reason: string } | null;
  losingReply: { move: MoveInput; reason: string } | null;
  coverage: { checkedReplies: number; totalReplies: number; complete: boolean; exchangeComplete: boolean; nodes: number };
  warnings: string[];
}
export interface ExpertReport {
  version: 'xiangqi-expert/v1'; phase: Phase; perspective: Color;
  experiences?: ExperienceHint[]; knowledge?: KnowledgeHint[]; search?: SearchReport; searchError?: string;
  material: { red: number; black: number; balanceForSideToMove: number };
  safety: PieceSafety[]; formation: { red: Formation; black: Formation }; lastMove: string | null; priorities: string[];
  principles: Principle[]; candidates: MoveReview[];
  coverage: { reviewedMoves: number; totalMoves: number; nodes: number; budgetExhausted: boolean };
  limitations: string[];
}
export interface ExpertOptions { maxNodes?: number; maxMs?: number; exchangeDepth?: number; candidateLimit?: number }
class Budget {
  nodes = 0; exhausted = false;
  private deadline: number;
  readonly maxNodes: number;
  constructor(options: ExpertOptions) {
    this.maxNodes = Math.max(0, Math.min(50000, options.maxNodes ?? 5000));
    this.deadline = performance.now() + Math.max(0, options.maxMs ?? 80);
  }
  take(): boolean {
    if (this.nodes >= this.maxNodes || performance.now() >= this.deadline) { this.exhausted = true; return false; }
    this.nodes++; return true;
  }
}
const name = (p: Piece) => `${colorName(p.color)}${glyph(p)}@${coordinate(p)}`;
const plainMove = (m: MoveInput): MoveInput => ({ from: { ...m.from }, to: { ...m.to } });
export function phaseOf(p: Position): Phase {
  const majors = p.board.filter(x => x && ['rook', 'cannon', 'horse'].includes(x.kind)).length;
  if (majors <= 6) return 'endgame';
  return p.moves.length < 20 ? 'opening' : 'middlegame';
}
// Stable phase for a whole review: capturing one piece must not create a fake
// gain simply because every remaining horse suddenly gets re-valued.
export function pieceValue(p: Piece, phase: Phase): number {
  if (p.kind === 'king') return 0; // mate is adjudicated, never traded for material
  if (p.kind === 'horse') return phase === 'endgame' ? 450 : 400;
  if (p.kind === 'cannon') return phase === 'endgame' ? 400 : 450;
  if (p.kind === 'pawn') return 100 + ((p.color === 1 ? p.y <= 4 : p.y >= 5) ? 80 : 0);
  return VALUES[p.kind];
}
function material(p: Position, color: Color, phase: Phase): number {
  return p.board.reduce((sum, x) => sum + (x?.color === color ? pieceValue(x, phase) : 0), 0);
}
function positional(p: Position, color: Color, phase: Phase): number {
  let score = 0;
  for (const piece of p.board) {
    if (!piece || piece.color !== color) continue;
    const forward = color === 1 ? 9 - piece.y : piece.y;
    const center = 4 - Math.abs(4 - piece.x);
    if (piece.kind === 'horse') {
      // Count usable horse destinations, not just geographical centrality.
      const mobility = legalMoves({ ...p, next: color, winner: null }, piece).length;
      score += mobility * 5 + center * 3;
      if (phase === 'opening' && forward > 0) score += 18;
    } else if (piece.kind === 'rook') {
      let freedom = 0;
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        for (let x = piece.x + dx, y = piece.y + dy; x >= 0 && x < 9 && y >= 0 && y < 10; x += dx, y += dy) {
          if (at(p.board, { x, y })) break;
          freedom++;
        }
      }
      score += freedom * 2;
      if (phase === 'opening' && forward > 0) score += 12;
    } else if (piece.kind === 'pawn') score += forward * 2 + center;
    else if (piece.kind === 'king' && phase !== 'endgame') score -= forward * 8;
  }
  return score;
}
export function inspectSafety(p: Position, phase = phaseOf(p)): PieceSafety[] {
  return p.board.flatMap(piece => {
    if (!piece) return [];
    const legalAttackers = legalCapturesTo({ ...p, next: other(piece.color), winner: null }, piece)
      .map(m => name(at(p.board, m.from)!));
    const defenders = p.board.filter(x => x && x.color === piece.color && x.id !== piece.id && controlsSquare(p.board, x, piece)) as Piece[];
    const without = p.board.slice(); without[index(piece)] = null;
    return [{ piece: name(piece), id: piece.id, color: piece.color, square: { x: piece.x, y: piece.y }, value: pieceValue(piece, phase),
      legalAttackers, geometricDefenders: defenders.map(name), loose: legalAttackers.length > 0 && defenders.length === 0,
      pinnedToKing: piece.kind !== 'king' && !inCheck(p.board, piece.color) && inCheck(without, piece.color) }];
  });
}
interface Exchange { gain: number; line: string[]; moves: MoveInput[]; complete: boolean }
function exchange(p: Position, square: Point, phase: Phase, depth: number, budget: Budget): Exchange {
  if (p.winner) return { gain: 0, line: [], moves: [], complete: true };
  const captures = legalCapturesTo(p, square);
  if (!captures.length) return { gain: 0, line: [], moves: [], complete: true };
  if (depth === 0) return { gain: 0, line: [], moves: [], complete: false };
  let gain = 0, line: string[] = [], moves: MoveInput[] = [], complete = true;
  for (const move of captures) {
    if (!budget.take()) { complete = false; break; }
    const value = pieceValue(at(p.board, square)!, phase), q = play(p, move);
    const response = exchange(q, square, phase, depth - 1, budget);
    complete &&= response.complete;
    const net = value - response.gain;
    if (net > gain) { gain = net; line = [q.moves.at(-1)!.notation, ...response.line]; moves = [plainMove(move), ...response.moves]; }
  }
  // Both sides may decline this same-square exchange. While in check, that
  // abstraction may be impossible; callers explicitly label it a SEE estimate.
  return { gain, line, moves, complete };
}
function roughPriority(p: Position, m: MoveInput): number {
  const target = at(p.board, m.to), piece = at(p.board, m.from)!;
  return (target ? VALUES[target.kind] : 0) * 10 + (piece.kind === 'horse' || piece.kind === 'rook' ? 20 : 0)
    + (4 - Math.abs(4 - m.to.x));
}
function review(p: Position, move: MoveInput, budget: Budget, options: ExpertOptions): MoveReview {
  const phase = phaseOf(p), side = p.next, after = play(p, move), notation = after.moves.at(-1)!.notation;
  const captured = at(p.board, move.to), gain = captured ? pieceValue(captured, phase) : 0;
  const positionDelta = positional(after, side, phase) - positional(p, side, phase);
  const out: MoveReview = { move: plainMove(move), notation, risk: 'uncertain', score: positionDelta, immediateGain: gain, estimatedNet: gain,
    positionalDelta: positionDelta, bestReply: null, line: [notation], variation: [plainMove(move)], terminal: null, losingReply: null,
    coverage: { checkedReplies: 0, totalReplies: 0, complete: false, exchangeComplete: true, nodes: 0 }, warnings: [] };
  const startedNodes = budget.nodes;
  if (after.winner) {
    out.terminal = { winner: after.winner, reason: after.endReason! };
    out.risk = after.winner === side ? 'win' : after.winner === 'draw' ? 'no-direct-loss-found' : 'loss';
    out.score = after.winner === side ? 1000000 : after.winner === 'draw' ? 0 : -1000000;
    out.coverage.complete = true;
    return out;
  }
  // Captures first, then checking replies: a quiet move cannot conceal a direct
  // free rook merely because a time budget expires halfway through the list.
  const replies = legalMoves(after).map(m => {
    const board = after.board.slice(), piece = at(board, m.from)!;
    board[index(m.from)] = null; board[index(m.to)] = { ...piece, ...m.to };
    return { move: m, capture: at(after.board, m.to), check: inCheck(board, side) };
  });
  replies.sort((a, b) => ((b.capture ? VALUES[b.capture.kind] * 10 : 0) + (b.check ? 100 : 0))
    - ((a.capture ? VALUES[a.capture.kind] * 10 : 0) + (a.check ? 100 : 0)));
  out.coverage.totalReplies = replies.length;
  let worstLoss = 0;
  for (const { move: reply, capture } of replies) {
    if (!budget.take()) break;
    const q = play(after, reply);
    out.coverage.checkedReplies++;
    if (q.winner === other(side)) {
      out.losingReply = { move: plainMove(reply), reason: q.endReason! };
      out.bestReply = plainMove(reply); out.line = [notation, q.moves.at(-1)!.notation]; out.variation = [plainMove(move), plainMove(reply)];
      // One concrete legal mate/stalemate reply is sufficient evidence; no need
      // to finish all replies before warning about this counterexample.
      continue;
    }
    if (q.winner === side || q.winner === 'draw') continue;
    if (capture && !q.winner) {
      const response = exchange(q, reply.to, phase, Math.max(0, Math.min(6, options.exchangeDepth ?? 6)), budget);
      out.coverage.exchangeComplete &&= response.complete;
      const loss = pieceValue(capture, phase) - response.gain;
      if (loss > worstLoss) {
        worstLoss = loss;
        if (!out.losingReply) { out.bestReply = plainMove(reply); out.line = [notation, q.moves.at(-1)!.notation, ...response.line]; out.variation = [plainMove(move), plainMove(reply), ...response.moves]; }
      }
    }
  }
  out.coverage.complete = out.coverage.checkedReplies === replies.length;
  out.coverage.nodes = budget.nodes - startedNodes;
  out.estimatedNet = gain - worstLoss;
  if (out.losingReply) {
    out.risk = 'loss'; out.score = -1000000;
    out.warnings.push(`已验证：对手可用 ${out.line[1]} 使我方${out.losingReply.reason === 'checkmate' ? '被将死' : out.losingReply.reason === 'stalemate' ? '困毙' : '规则判负'}。`);
  } else {
    out.risk = out.estimatedNet <= -250 ? 'material-loss' : !out.coverage.complete || !out.coverage.exchangeComplete ? 'uncertain' : out.estimatedNet < 0 ? 'exchange-risk' : 'no-direct-loss-found';
    out.score = out.estimatedNet * 10 + positionDelta - (!out.coverage.complete || !out.coverage.exchangeComplete ? 3000 : 0);
    if (out.estimatedNet < 0) out.warnings.push(`同格交换估计净亏 ${-out.estimatedNet} 分（兵约100）；对方反击：${out.line[1] ?? '尚未覆盖'}。不排除其他位置的弃子补偿，须试算。`);
  }
  if (!out.coverage.complete || !out.coverage.exchangeComplete) out.warnings.push('预算或交换深度达到上限，未算完的部分是未知，不能视为安全。');
  if (after.moves.at(-1)!.check && !after.winner) out.warnings.push('将军只是先手，不等于赚子或成杀；必须检查对方应将。');
  return out;
}
export function reviewMove(p: Position, move: MoveInput, options: ExpertOptions = {}): MoveReview {
  return review(p, move, new Budget(options), options);
}
export function compareMoves(p: Position, moves: MoveInput[], options: ExpertOptions = {}): MoveReview[] {
  if (moves.length < 1 || moves.length > 6) throw new Error('每次比较 1–6 个候选');
  // Independent equal budgets prevent the first candidate from starving later
  // ones. The total time is bounded, not maxMs times the number of candidates.
  return moves.map(move => reviewMove(p, move, { ...options, maxMs: (options.maxMs ?? 120) / moves.length, maxNodes: Math.floor((options.maxNodes ?? 6000) / moves.length) }))
    .sort((a, b) => b.score - a.score);
}
function formation(p: Position, color: Color): Formation {
  const own = p.board.filter(x => x?.color === color) as Piece[], king = own.find(x => x.kind === 'king');
  const view = { ...p, next: color, winner: null };
  return { advisors: own.filter(x => x.kind === 'advisor').length, elephants: own.filter(x => x.kind === 'elephant').length,
    legalKingExits: king ? legalMoves(view, king).length : 0,
    undevelopedMajors: own.filter(x => ['rook', 'horse'].includes(x.kind) && x.y === (color === 1 ? 9 : 0)).map(name),
    horseMobility: own.filter(x => x.kind === 'horse').map(x => ({ piece: name(x), destinations: legalMoves(view, x).length })) };
}
function knowledge(p: Position, phase: Phase, safety: PieceSafety[]): Principle[] {
  const own = p.board.filter(x => x?.color === p.next) as Piece[];
  const rules: Principle[] = [];
  const loose = safety.filter(x => x.color === p.next && x.loose);
  const pins = safety.filter(x => x.pinnedToKing);
  if (loose.length) rules.push({ id: 'hanging-pieces', title: '先处理失守大子', evidence: loose.map(x => x.piece), advice: '先算对方能否白吃，再比较撤退、保护、反击；几何保护不等于能合法回吃。' });
  if (pins.length) rules.push({ id: 'pins', title: '将帅安全牵制', evidence: pins.map(x => x.piece), advice: '这些子离开原位可能暴露将帅，不能把它们的几何保护当成可靠回吃；也可能涉及马腿或炮架。' });
  if (phase === 'opening') rules.push({ id: 'development', title: '开局出子与车路', evidence: own.filter(x => ['rook', 'horse'].includes(x.kind) && x.y === (x.color === 1 ? 9 : 0)).map(name), advice: '尽早协调车马炮、疏通车路；避免无收益重复移动。不要为出子把车放到对方车口；安全与具体战术优先于口诀。' });
  const recent = p.moves.filter(x => x.color === p.next).slice(-3);
  if (phase === 'opening' && recent.some(x => recent.filter(y => y.piece.id === x.piece.id).length >= 2)) rules.push({ id: 'repeated-development', title: '重复动子须有具体收益', evidence: recent.map(x => x.notation), advice: '最近多次移动同一枚子；若不是必要应将、得子或制造有效威胁，比较发展其他子力。不能只为避免重复而走不安全的棋。' });
  if (own.some(x => x.kind === 'horse')) rules.push({ id: 'horse-legs', title: '马看实际活动空间', evidence: own.filter(x => x.kind === 'horse').map(name), advice: '检查马腿、可落脚点和被兵卒限制情况。挂角、卧槽等形状只是攻势线索，必须验证应将与反将。' });
  if (own.some(x => x.kind === 'cannon')) rules.push({ id: 'cannon-screen', title: '炮架是动态资源', evidence: own.filter(x => x.kind === 'cannon').map(name), advice: '吃子必须恰有一个炮架；移动或吃掉炮架会改变双方炮线。沉底炮、重炮形状不保证成杀；切勿贪兵后被马车白吃。' });
  rules.push({ id: 'king-safety', title: '九宫与对手先手', evidence: [...own.filter(x => x.kind === 'king').map(name), `己方剩 ${own.filter(x => x.kind === 'advisor').length} 士仕、${own.filter(x => x.kind === 'elephant').length} 相象`], advice: '先看对方将军、杀棋、吃大子，再看己方进攻。士象缺损、肋道及底线开放时优先验证直接杀；困毙也判负。' });
  if (phase === 'endgame') rules.push({ id: 'endgame', title: '残局价值与胜和边界', evidence: ['当前大子数量不超过6'], advice: '残局马炮价值随空间与炮架变化；支持将帅与兵卒协同。优势可考虑简化，但不能兑成无法取胜的残局；理论胜和须具体计算，当前无残局库。' });
  const balance = material(p, p.next, phase) - material(p, other(p.next), phase);
  if (Math.abs(balance) >= 400) rules.push({ id: 'material-plan', title: balance > 0 ? '优势时避免无补偿损失' : '劣势时寻找有依据的反击', evidence: [`当前行棋方子力差 ${balance}`], advice: balance > 0 ? '优先保住大子并处理反杀；是否兑子取决于兑后局面，不是见子就换。' : '可考虑主动子力与弃子攻杀，但须给出具体变化，不能把没有补偿的送子称为主动。' });
  return rules.slice(0, 8);
}
export function analyzeExpert(p: Position, options: ExpertOptions = {}): Analysis {
  const base = analyze(p), phase = phaseOf(p), safety = inspectSafety(p, phase);
  const all = base.legalMoves.slice().sort((a, b) => roughPriority(p, b) - roughPriority(p, a));
  const count = Math.max(0, Math.min(all.length, options.candidateLimit ?? 12));
  // Cheap positional diversity stops a greedy capture-only shortlist. Rank all
  // roots by positional delta as well, then mix with tactical candidates.
  const positionalOrder = all.map(move => { const q = play(p, move); return { move, score: q.winner === p.next ? 1000000 : positional(q, p.next, phase) }; }).sort((a, b) => b.score - a.score);
  const shortlist: MoveInput[] = [];
  for (let i = 0; shortlist.length < count && i < all.length; i++) {
    for (const move of [all[i], positionalOrder[i]?.move]) {
      if (move && !shortlist.some(x => same(x.from, move.from) && same(x.to, move.to))) shortlist.push(move);
      if (shortlist.length >= count) break;
    }
  }
  const started = performance.now(), budget = new Budget(options);
  const candidates: MoveReview[] = [];
  // Fair per-candidate slices; unknown candidates stay explicitly uncertain.
  for (let i = 0; i < shortlist.length; i++) {
    const remaining = Math.max(0, (options.maxMs ?? 80) - (performance.now() - started));
    const nodes = Math.max(0, (options.maxNodes ?? 5000) - budget.nodes);
    const local = new Budget({ maxMs: remaining / (shortlist.length - i), maxNodes: Math.floor(nodes / (shortlist.length - i)) });
    const r = review(p, shortlist[i], local, options);
    budget.nodes += local.nodes; budget.exhausted ||= local.exhausted;
    candidates.push(r);
  }
  candidates.sort((a, b) => b.score - a.score);
  const red = material(p, 1, phase), black = material(p, 2, phase);
  const ownThreats = safety.filter(x => x.color === p.next && x.legalAttackers.length).sort((a, b) => b.value - a.value);
  const expert: ExpertReport = { version: 'xiangqi-expert/v1', phase, perspective: p.next, material: { red, black, balanceForSideToMove: p.next === 1 ? red - black : black - red },
    safety, formation: { red: formation(p, 1), black: formation(p, 2) }, lastMove: p.moves.at(-1)?.notation ?? null,
    priorities: [base.inCheck ? '当前被将军，必须先应将。' : '先审查对方将军与直接杀，再评估吃子、交换和布局。', ...ownThreats.slice(0, 4).map(x => `${x.piece} 可被 ${x.legalAttackers.join('、')} 合法攻击${x.loose ? '，无几何保护' : '；有保护仍须验算交换'}。`)],
    principles: knowledge(p, phase, safety), candidates,
    coverage: { reviewedMoves: candidates.length, totalMoves: all.length, nodes: budget.nodes, budgetExhausted: budget.exhausted },
    limitations: ['反击检查覆盖候选后的对方一手；未覆盖候选和预算截断不代表安全。', '同格交换最多6次后续吃子，允许放弃交换；不完整搜索异地战术、强制应将及长期弃子补偿。', '动态子力、活动性与专家原则均为启发式，不是胜率；战术计算不含完整开残局库或外部引擎，来源定式与案例另行按需注入。'] };
  return { ...base, redScore: red, blackScore: black, expert,
    candidates: candidates.slice(0, 8).map(r => ({ ...r.move, score: r.score, label: `${r.notation} · ${r.risk} · 交换估计 ${r.estimatedNet}` })),
    summary: `${base.summary} 专家阶段=${phase}；已审查 ${candidates.length}/${all.length} 个候选，当前方子力差 ${expert.material.balanceForSideToMove}。` };
}
export function needsRiskAcknowledgement(review: MoveReview): boolean { return review.risk === 'loss' || review.risk === 'material-loss'; }
export class MoveRiskError extends Error {
  constructor(public readonly review: MoveReview) {
    super(`专家审查发现风险，尚未落子。请比较替代走法；若坚持有依据的弃子，需用 riskAcknowledgement 明确解释补偿或不可避免的败势。${JSON.stringify(review)}`);
    this.name = 'MoveRiskError';
  }
}
