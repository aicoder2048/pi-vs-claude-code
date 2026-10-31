import {
  analyze, at, colorName, controlsSquare, coordinate, glyph, inCheck, index, legalCapturesTo, legalMoves,
  other, play, same, VALUES, type Analysis, type Color, type MoveInput, type Piece, type Point, type Position,
} from './engine';

import type { SearchReport } from './search';
import { evaluatePosition, type PositionalEvaluation } from './evaluation';
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
  coverage: { checkedReplies: number; totalReplies: number; complete: boolean; exchangeComplete: boolean; nodes: number; quietThreatsComplete?: boolean };
  warnings: string[];
  search?: SearchReport;
  searchError?: string;
}
export interface ExpertReport {
  version: 'xiangqi-expert/v1'; phase: Phase; perspective: Color;
  experiences?: ExperienceHint[]; knowledge?: KnowledgeHint[]; search?: SearchReport; searchError?: string;
  material: { red: number; black: number; balanceForSideToMove: number };
  position: { red: PositionalEvaluation; black: PositionalEvaluation; balanceForSideToMove: number };
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
  return evaluatePosition(p, color, phase).total - evaluatePosition(p, other(color), phase).total;
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
// Specialized two-turn trap check: after a quiet cannon redeployment, try EVERY
// legal defence of an attacked rook. A single escape/capture/check refutes the
// trap. Same-square compensation remains a bounded estimate, not a mate proof.
function cannonTrap(p: Position, cannon: Piece, rook: Piece, phase: Phase, budget: Budget, options: ExpertOptions):
  { loss: number; moves: MoveInput[]; line: string[] } | null | 'unknown' {
  const side = p.next, baseline = material(p, side, phase) - material(p, other(side), phase);
  let best = { loss: Infinity, moves: [] as MoveInput[], line: [] as string[] };
  for (const defence of legalMoves(p)) {
    if (!budget.take()) return 'unknown';
    const q = play(p, defence);
    if (q.winner) return null; // terminal defences need a different proof
    const target = q.board.find(x => x?.id === rook.id), attacker = q.board.find(x => x?.id === cannon.id);
    if (!target || !attacker) return null;
    const capture = legalCapturesTo(q, target).find(m => same(m.from, attacker));
    if (!capture) return null;
    const r = play(q, capture);
    if (r.winner) return null;
    const compensation = exchange(r, capture.to, phase, Math.max(0, Math.min(6, options.exchangeDepth ?? 6)), budget);
    if (!compensation.complete) return 'unknown';
    const loss = baseline - (material(r, side, phase) - material(r, other(side), phase)) - compensation.gain;
    if (loss < 250) return null;
    if (loss < best.loss) best = { loss, moves: [plainMove(defence), plainMove(capture), ...compensation.moves],
      line: [q.moves.at(-1)!.notation, r.moves.at(-1)!.notation, ...compensation.line] };
  }
  return Number.isFinite(best.loss) ? best : null;
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
  out.coverage.quietThreatsComplete = out.coverage.complete;
  // Direct-capture review alone misses “redeploy cannon, then take trapped rook”.
  // Check these quiet threats within the SAME budget; truncation stays unknown.
  if (!out.losingReply) for (const { move: reply, capture } of replies) {
    if (capture || at(after.board, reply.from)?.kind !== 'cannon') continue;
    if (!budget.take()) { out.coverage.quietThreatsComplete = false; break; }
    const q = play(after, reply);
    if (q.winner) continue;
    const cannon = at(q.board, reply.to)!;
    const targets = q.board.filter((x): x is Piece => !!x && x.color === side && x.kind === 'rook'
      && controlsSquare(q.board, cannon, x));
    for (const rook of targets) {
      const trap = cannonTrap(q, cannon, rook, phase, budget, options);
      if (trap === 'unknown') { out.coverage.quietThreatsComplete = false; break; }
      if (trap && trap.loss > worstLoss) {
        worstLoss = trap.loss; out.bestReply = plainMove(reply);
        out.line = [notation, q.moves.at(-1)!.notation, ...trap.line];
        out.variation = [plainMove(move), plainMove(reply), ...trap.moves];
        out.warnings.push(`炮线陷阱：${q.moves.at(-1)!.notation} 后，已枚举全部合法防守；同格交换补偿后仍估计至少亏 ${trap.loss} 分。异地弃子补偿未穷尽。`);
      }
    }
  }
  out.coverage.nodes = budget.nodes - startedNodes;
  out.estimatedNet = gain - worstLoss;
  if (out.losingReply) {
    out.risk = 'loss'; out.score = -1000000;
    out.warnings.push(`已验证：对手可用 ${out.line[1]} 使我方${out.losingReply.reason === 'checkmate' ? '被将死' : out.losingReply.reason === 'stalemate' ? '困毙' : '规则判负'}。`);
  } else {
    out.risk = out.estimatedNet <= -250 ? 'material-loss' : !out.coverage.complete || !out.coverage.exchangeComplete || !out.coverage.quietThreatsComplete ? 'uncertain' : out.estimatedNet < 0 ? 'exchange-risk' : 'no-direct-loss-found';
    out.score = out.estimatedNet * 10 + positionDelta - (!out.coverage.complete || !out.coverage.exchangeComplete || !out.coverage.quietThreatsComplete ? 3000 : 0);
    if (out.estimatedNet < 0) out.warnings.push(`同格交换估计净亏 ${-out.estimatedNet} 分（兵约100）；对方反击：${out.line[1] ?? '尚未覆盖'}。不排除其他位置的弃子补偿，须试算。`);
  }
  if (!out.coverage.complete || !out.coverage.exchangeComplete || !out.coverage.quietThreatsComplete) out.warnings.push('预算或交换深度达到上限，未算完的部分是未知，不能视为安全。');
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
  if (loose.length) rules.push({ id: 'hanging-pieces', title: '先处理失守大子', evidence: loose.map(x => x.piece), advice: '核查合法回吃并处理失守子。' });
  if (pins.length) rules.push({ id: 'pins', title: '将帅安全牵制', evidence: pins.map(x => x.piece), advice: '离位前重验将帅安全与合法回吃。' });
  if (phase === 'opening') rules.push({ id: 'development', title: '开局出子与车路', evidence: own.filter(x => ['rook', 'horse'].includes(x.kind) && x.y === (x.color === 1 ? 9 : 0)).map(name), advice: '在安全前提下协调出子与车路。' });
  const recent = p.moves.filter(x => x.color === p.next).slice(-3);
  if (phase === 'opening' && recent.some(x => recent.filter(y => y.piece.id === x.piece.id).length >= 2)) rules.push({ id: 'repeated-development', title: '重复动子须有具体收益', evidence: recent.map(x => x.notation), advice: '复核重复动子是否有具体收益。' });
  if (own.some(x => x.kind === 'horse')) rules.push({ id: 'horse-legs', title: '马看实际活动空间', evidence: own.filter(x => x.kind === 'horse').map(name), advice: '按实际马腿与合法落点判断活动。' });
  if (own.some(x => x.kind === 'cannon')) rules.push({ id: 'cannon-screen', title: '炮架是动态资源', evidence: own.filter(x => x.kind === 'cannon').map(name), advice: '走子后重新核对双方炮架。' });
  rules.push({ id: 'king-safety', title: '九宫与对手先手', evidence: [...own.filter(x => x.kind === 'king').map(name), `己方剩 ${own.filter(x => x.kind === 'advisor').length} 士仕、${own.filter(x => x.kind === 'elephant').length} 相象`], advice: '先核查直接杀与困毙风险。' });
  if (phase === 'endgame') rules.push({ id: 'endgame', title: '残局价值与胜和边界', evidence: ['当前大子数量不超过6'], advice: '按空间和炮架比较残局兑换。' });
  const balance = material(p, p.next, phase) - material(p, other(p.next), phase);
  if (Math.abs(balance) >= 400) rules.push({ id: 'material-plan', title: balance > 0 ? '优势时避免无补偿损失' : '劣势时寻找有依据的反击', evidence: [`当前行棋方子力差 ${balance}`], advice: balance > 0 ? '保住优势并核对兑后局面。' : '用具体变化核验反击补偿。' });
  return rules.slice(0, 8);
}
export function analyzeExpert(p: Position, options: ExpertOptions = {}): Analysis {
  const base = analyze(p), phase = phaseOf(p), safety = inspectSafety(p, phase);
  const all = base.legalMoves.slice().sort((a, b) => roughPriority(p, b) - roughPriority(p, a));
  const count = Math.max(0, Math.min(all.length, options.candidateLimit ?? 12));
  // Cheap positional diversity stops a greedy capture-only shortlist. Rank all
  // roots by positional delta as well, then mix with tactical candidates.
  const positionalOrder = all.map(move => { const q = play(p, move); return { move, after: q, score: q.winner === p.next ? 1000000 : positional(q, p.next, phase) }; }).sort((a, b) => b.score - a.score);
  // Preserve real escape candidates when richer positional terms favor keeping
  // an attacked piece on an attractive square. Heuristics must not crowd out
  // the old free-piece safeguards.
  const threatened = safety.filter(x => x.color === p.next && x.value >= 250 && x.legalAttackers.length);
  const escapes = positionalOrder.filter(({ move, after }) => threatened.some(x => same(x.square, move.from))
    && legalCapturesTo({ ...after, next: other(p.next) }, move.to).length === 0);
  const shortlist: MoveInput[] = [];
  for (let i = 0; shortlist.length < count && i < all.length; i++) {
    for (const move of [all[i], escapes[i]?.move, positionalOrder[i]?.move]) {
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
  const redPosition = evaluatePosition(p, 1, phase), blackPosition = evaluatePosition(p, 2, phase);
  const ownPosition = p.next === 1 ? redPosition : blackPosition;
  const ownThreats = safety.filter(x => x.color === p.next && x.legalAttackers.length).sort((a, b) => b.value - a.value);
  const expert: ExpertReport = { version: 'xiangqi-expert/v1', phase, perspective: p.next, material: { red, black, balanceForSideToMove: p.next === 1 ? red - black : black - red },
    position: { red: redPosition, black: blackPosition, balanceForSideToMove: p.next === 1 ? redPosition.total - blackPosition.total : blackPosition.total - redPosition.total },
    safety, formation: { red: formation(p, 1), black: formation(p, 2) }, lastMove: p.moves.at(-1)?.notation ?? null,
    priorities: [base.inCheck ? '当前被将军，必须先应将。' : '先审查对方将军与直接杀，再评估吃子、交换和布局。', ...ownThreats.slice(0, 4).map(x => `${x.piece} 可被 ${x.legalAttackers.join('、')} 合法攻击${x.loose ? '，无几何保护' : '；有保护仍须验算交换'}。`)],
    principles: [...knowledge(p, phase, safety),
      ...(ownPosition.inactiveMajors.length ? [{ id: 'activate-idle-pieces', title: '把闲置子力接入战斗', evidence: ownPosition.inactiveMajors,
        advice: '在安全前提下比较激活闲子。' }] : []),
      ...(ownPosition.repeatedMoves.length ? [{ id: 'tempo-waste', title: '无收益往返需要重新制定计划', evidence: ownPosition.repeatedMoves,
        advice: '复核往返必要性并重新制定计划。' }] : [])], candidates,
    coverage: { reviewedMoves: candidates.length, totalMoves: all.length, nodes: budget.nodes, budgetExhausted: budget.exhausted },
    limitations: ['反击检查覆盖候选后的对方一手，并有界检查调炮困车后的全部合法防守；未覆盖候选和预算截断不代表安全。', '同格交换最多6次后续吃子，允许放弃交换；不完整搜索异地战术、强制应将及长期弃子补偿。', '动态子力、活动性与专家原则均为启发式，不是胜率；战术计算不含完整开残局库或外部引擎，来源定式与案例另行按需注入。'] };
  return { ...base, redScore: red, blackScore: black, expert,
    candidates: candidates.slice(0, 8).map(r => ({ ...r.move, score: r.score, label: `${r.notation} · ${r.risk} · 交换估计 ${r.estimatedNet}` })),
    summary: `${base.summary} 专家阶段=${phase}；已审查 ${candidates.length}/${all.length} 个候选，当前方子力差 ${expert.material.balanceForSideToMove}。` };
}
export function needsRiskAcknowledgement(review: MoveReview): boolean { return review.risk === 'loss' || review.risk === 'material-loss'; }
export class MoveRiskError extends Error {
  constructor(public readonly review: MoveReview) {
    super(`专家审查发现风险，尚未落子。优先比较替代走法；坚持接受风险前 read_skill('playbook-risk-acknowledgement')。${JSON.stringify({ risk: review.risk, estimatedNet: review.estimatedNet, line: review.line, warnings: review.warnings })}`);
    this.name = 'MoveRiskError';
  }
}
