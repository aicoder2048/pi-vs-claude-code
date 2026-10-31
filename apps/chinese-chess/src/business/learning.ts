import { createHash } from 'node:crypto';
import {
  at, controlsSquare, emptyPosition, inCheck, inside, legalCapturesTo, legalMoves, other, play, positionFromPieces, same,
  type Color, type MoveInput, type Piece, type Point, type Position,
} from './engine';
import { phaseOf, reviewMove, type ExpertReport, type MoveReview } from './expert';

export const LEARNING_VERSION = 'xiangqi-learning/v1';
export const VALIDATOR_VERSION = 'local-tactics/2';
export type Symmetry = 'identity' | 'mirror' | 'rotate-swap' | 'mirror-rotate-swap';
export const SYMMETRIES: Symmetry[] = ['identity', 'mirror', 'rotate-swap', 'mirror-rotate-swap'];
export type Motif = 'screen-removal-capture' | 'checking-blunder' | 'poisoned-capture' | 'unsafe-destination' | 'mate-in-one';
export interface LearningRecord {
  id: string; human: Color; moves: MoveInput[];
  outcome: { winner: Color | 'draw'; reason: string } | null;
  acknowledgedPlies: number[];
}
export interface CaseSource { gameId: string; ply: number; actor: 'human' | 'machine'; color: Color; exploited: boolean }
export interface CaseSeed {
  prefix: MoveInput[]; mistake: MoveInput; reply: MoveInput; alternative: MoveInput;
  source: CaseSource; deliberateRisk: boolean;
}
export interface TacticalCase {
  id: string; key: string; validator: typeof VALIDATOR_VERSION; motif: Motif; title: string;
  positionKeys: { before: string[]; after: string[] };
  seed: CaseSeed; sources: CaseSource[];
  evidence: 'legal-unanswered-capture' | 'legal-one-reply-loss';
  victimKind: Piece['kind'] | null; attackerKind: Piece['kind'];
  estimatedNet: number; alternativeNet: number;
  variation: MoveInput[]; line: string[]; limitations: string[];
}
export interface ExperienceHint {
  caseId: string; title: string; match: 'exact-avoid' | 'exact-punish' | 'similar-avoid' | 'similar-punish';
  advice: string; sourceCount: number; sources: CaseSource[];
  currentMove: MoveInput; currentLine: string[]; currentNet: number;
  verification: 'rechecked-now'; historicalLine: string[]; limitations: string[];
}
export interface ReviewFinding {
  ply: number; actor: 'human' | 'machine'; notation: string; status: 'verified-local' | 'candidate';
  motif: Motif; estimatedNet: number; refutation: string[]; actualReply: string | null; exploited: boolean;
  alternative: string | null; caseId: string | null; reason: string;
}
export interface PostGameReview {
  version: typeof LEARNING_VERSION; validator: typeof VALIDATOR_VERSION; gameId: string; fingerprint: string;
  completedAt: string; plies: number; findings: ReviewFinding[];
  metrics: { human: { localErrors: number; opportunitiesTaken: number }; machine: { localErrors: number; opportunitiesTaken: number }; candidates: number };
  limitations: string[];
}
export interface ReviewSummary { gameId: string; plies: number; completedAt: string; verified: number; candidates: number; humanErrors: number; machineErrors: number }
export interface LearningOverview {
  status: 'starting' | 'idle' | 'reviewing' | 'error'; activeGame: string | null; processedPlies: number; totalPlies: number;
  caseCount: number; reviews: ReviewSummary[]; errors: string[];
}
export interface ReviewOptions {
  signal?: AbortSignal;
  onProgress?: (ply: number, total: number) => void;
  maxMsPerMove?: number; maxNodesPerMove?: number; maxAlternatives?: number;
}
const cloneMove = (m: MoveInput): MoveInput => ({ from: { x: m.from.x, y: m.from.y }, to: { x: m.to.x, y: m.to.y } });
export const moveEquals = (a: MoveInput, b: MoveInput): boolean => same(a.from, b.from) && same(a.to, b.to);
export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
export function validGameId(id: unknown): id is string { return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id); }
function readMove(value: unknown): MoveInput {
  if (!value || typeof value !== 'object') throw new Error('无效的走法');
  const m = value as MoveInput;
  if (!inside(m.from) || !inside(m.to)) throw new Error('无效的走法坐标');
  return cloneMove(m);
}
export function normalizeRecord(raw: unknown): LearningRecord {
  if (!raw || typeof raw !== 'object') throw new Error('棋谱不是对象');
  const r = raw as Record<string, any>;
  if (r.format !== 'chinese-chess/v1' || !validGameId(r.id) || (r.human !== 1 && r.human !== 2)) throw new Error('棋谱格式、ID 或执棋方无效');
  if (!Array.isArray(r.moves) || r.moves.length > 600) throw new Error('棋谱超过 600 半回合上限或走法无效');
  const moves = r.moves.map(readMove);
  let p = emptyPosition(); for (const move of moves) p = play(p, move);
  const o = r.outcome;
  if (o) {
    const reasons = ['checkmate', 'stalemate', 'repetition', 'perpetual-check', 'no-progress', 'main-time', 'resign'];
    if (![1, 2, 'draw'].includes(o.winner) || !reasons.includes(o.reason)) throw new Error('无效的终局结果');
    if (p.winner && (p.winner !== o.winner || p.endReason !== o.reason)) throw new Error('保存的终局结果与规则重放不一致');
    if (!p.winner && !['resign', 'main-time'].includes(o.reason)) throw new Error('棋盘未达到所声称的终局');
    if (o.reason === 'resign' && o.winner !== other(r.human)) throw new Error('认输结果不一致');
    if (o.reason === 'main-time' && o.winner !== other(p.next)) throw new Error('超时结果不一致');
  }
  return { id: r.id, human: r.human, moves, outcome: o ? { winner: o.winner, reason: o.reason } : null,
    acknowledgedPlies: Array.isArray(r.notes) ? r.notes.filter((n: any) => Number.isInteger(n?.ply) && typeof n.riskAcknowledgement === 'string' && n.riskAcknowledgement.trim()).map((n: any) => n.ply) : [] };
}
export function recordFingerprint(r: LearningRecord): string { return digest(JSON.stringify({ validator: VALIDATOR_VERSION, ...r })); }
export function transformPoint(p: Point, s: Symmetry): Point {
  let { x, y } = p;
  if (s.includes('mirror')) x = 8 - x;
  if (s.includes('rotate')) { x = 8 - x; y = 9 - y; }
  return { x, y };
}
export function transformMove(m: MoveInput, s: Symmetry): MoveInput { return { from: transformPoint(m.from, s), to: transformPoint(m.to, s) }; }
export function replayCasePrefix(prefix: MoveInput[], s: Symmetry = 'identity'): Position {
  let p = positionFromPieces(emptyPosition().board.filter(Boolean).map(x => ({ ...x!, ...transformPoint(x!, s), color: s.includes('rotate') ? other(x!.color) : x!.color })), s.includes('rotate') ? 2 : 1);
  for (const move of prefix) p = play(p, transformMove(move, s));
  return p;
}
export function boardIdentity(p: Position, s: Symmetry = 'identity'): string {
  const pieces = p.board.filter(Boolean).map(x => {
    const q = transformPoint(x!, s); return `${q.x},${q.y}:${s.includes('rotate') ? other(x!.color) : x!.color}:${x!.kind}`;
  }).sort();
  return `${s.includes('rotate') ? other(p.next) : p.next}|${pieces.join('|')}`;
}
function canonicalCaseKey(p: Position, mistake: MoveInput, reply: MoveInput): string {
  return SYMMETRIES.map(s => `${boardIdentity(p, s)}|${JSON.stringify(transformMove(mistake, s))}|${JSON.stringify(transformMove(reply, s))}`).sort()[0];
}
function motifOf(p: Position, r: MoveReview): Motif {
  if (r.losingReply) return 'mate-in-one';
  const after = play(p, r.move), last = after.moves.at(-1)!;
  if (last.check && r.bestReply) {
    const king = after.board.find(x => x?.kind === 'king' && x.color === after.next)!;
    const cannons = after.board.filter(x => x?.kind === 'cannon' && x.color === p.next && controlsSquare(after.board, x, king));
    const reply = play(after, r.bestReply);
    if (cannons.length && reply.moves.at(-1)!.captured && !inCheck(reply.board, after.next)) return 'screen-removal-capture';
  }
  return last.check ? 'checking-blunder' : last.captured ? 'poisoned-capture' : 'unsafe-destination';
}
const fullEnough = (r: MoveReview) => r.coverage.complete && r.coverage.exchangeComplete;
const reviewOptions = (o: ReviewOptions) => ({ maxMs: o.maxMsPerMove ?? 120, maxNodes: o.maxNodesPerMove ?? 10000 });
function localEvidence(p: Position, r: MoveReview): TacticalCase['evidence'] | null {
  if (!r.bestReply || !fullEnough(r)) return null;
  const after = play(p, r.move), q = play(after, r.bestReply);
  if (r.losingReply && q.winner === other(p.next)) return 'legal-one-reply-loss';
  const captured = q.moves.at(-1)!.captured;
  if (r.estimatedNet <= -250 && captured && !q.winner && !legalCapturesTo(q, r.bestReply.to).length) return 'legal-unanswered-capture';
  return null;
}
export function validateCase(seed: CaseSeed, options: ReviewOptions = {}): TacticalCase | null {
  if (!seed || !Array.isArray(seed.prefix) || seed.prefix.length > 599 || !validGameId(seed.source?.gameId) || seed.source.ply !== seed.prefix.length + 1 || !['human', 'machine'].includes(seed.source.actor) || seed.deliberateRisk) return null;
  try {
    const prefix = seed.prefix.map(readMove), mistake = readMove(seed.mistake), reply = readMove(seed.reply), alternative = readMove(seed.alternative);
    const p = replayCasePrefix(prefix);
    if (seed.source.color !== p.next || moveEquals(mistake, alternative)) return null;
    const bad = reviewMove(p, mistake, reviewOptions(options));
    const evidence = localEvidence(p, bad);
    if (!evidence || !bad.bestReply || !moveEquals(bad.bestReply, reply)) return null;
    const better = reviewMove(p, alternative, reviewOptions(options));
    if (!fullEnough(better) || better.risk === 'loss' || better.estimatedNet <= -250 || (bad.risk !== 'loss' && better.estimatedNet - bad.estimatedNet < 100)) return null;
    const key = canonicalCaseKey(p, mistake, reply), after = play(p, mistake), q = play(after, reply);
    // Verification does not trust stored scores, prose, motif or model reasons.
    const variation = bad.variation ?? [mistake, reply];
    let proof = p; for (const move of variation) proof = play(proof, move);
    return { id: digest(key).slice(0, 24), key, validator: VALIDATOR_VERSION, motif: motifOf(p, bad), title: motifOf(p, bad),
      positionKeys: { before: SYMMETRIES.map(s => boardIdentity(p, s)), after: SYMMETRIES.map(s => boardIdentity(after, s)) },
      seed: { prefix, mistake, reply, alternative, source: { ...seed.source }, deliberateRisk: false }, sources: [{ ...seed.source }],
      evidence, victimKind: q.moves.at(-1)!.captured?.kind ?? null, attackerKind: at(after.board, reply.from)!.kind,
      estimatedNet: bad.estimatedNet, alternativeNet: better.estimatedNet, variation: variation.map(cloneMove), line: bad.line,
      limitations: ['验证的是局部合法反例及有限范围的较安全替代，不是全局最优或强制败局证明。', '案例不修改模型权重；检索到旧经验仍须按当前棋盘和重复历史重验。'] };
  } catch { return null; }
}
const aborted = (o: ReviewOptions) => { if (o.signal?.aborted) throw new Error('复盘已取消'); };
// Async yielding also makes CLI reviews cancellable. Electron uses a dedicated
// Worker, so this full-record work never blocks authoritative chess clocks.
export async function reviewFinishedGame(r: LearningRecord, options: ReviewOptions = {}): Promise<{ review: PostGameReview; cases: TacticalCase[] }> {
  if (!r.outcome) throw new Error('未结束的棋局不会自动学习');
  let p = emptyPosition(); const findings: ReviewFinding[] = [], cases: TacticalCase[] = [];
  for (let i = 0; i < r.moves.length; i++) {
    aborted(options);
    const move = r.moves[i], reviewed = reviewMove(p, move, reviewOptions(options));
    if (reviewed.risk === 'loss' || reviewed.risk === 'material-loss') {
      const actual = r.moves[i + 1], ref = reviewed.bestReply;
      const exploited = !!actual && !!ref && moveEquals(actual, ref);
      const source: CaseSource = { gameId: r.id, ply: i + 1, actor: p.next === r.human ? 'human' : 'machine', color: p.next, exploited };
      let alternative: MoveReview | undefined;
      if (!r.acknowledgedPlies.includes(i + 1) && localEvidence(p, reviewed)) {
        // Never treat all losing moves in an already lost position as new errors.
        const moves = legalMoves(p).slice(0, Math.max(0, Math.min(120, options.maxAlternatives ?? 80)));
        for (let candidateIndex = 0; candidateIndex < moves.length; candidateIndex++) {
          if (candidateIndex % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
          aborted(options);
          const candidate = moves[candidateIndex];
          if (moveEquals(candidate, move)) continue;
          const a = reviewMove(p, candidate, reviewOptions(options));
          if (fullEnough(a) && a.risk !== 'loss' && a.estimatedNet > -250 && (reviewed.risk === 'loss' || a.estimatedNet - reviewed.estimatedNet >= 100)
            && (!alternative || a.score > alternative.score)) alternative = a;
        }
      }
      const sample = ref && alternative ? validateCase({ prefix: r.moves.slice(0, i), mistake: move, reply: ref, alternative: alternative.move, source, deliberateRisk: false }, options) : null;
      if (sample) cases.push(sample);
      findings.push({ ply: i + 1, actor: source.actor, notation: reviewed.notation, status: sample ? 'verified-local' : 'candidate', motif: motifOf(p, reviewed), estimatedNet: reviewed.estimatedNet,
        refutation: reviewed.line, actualReply: actual ? play(play(p, move), actual).moves.at(-1)!.notation : null,
        exploited, alternative: alternative?.notation ?? null, caseId: sample?.id ?? null,
        reason: sample ? '合法反例及较安全替代均已重验；只确认局部事实。' : r.acknowledgedPlies.includes(i + 1) ? '模型已明确接受弃子风险，不自动当成错误学习。' : '缺少完整局部证据或较安全替代，保留为候选，不进入专家案例库。' });
    }
    p = play(p, move); options.onProgress?.(i + 1, r.moves.length);
    if (i % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  const human = { localErrors: 0, opportunitiesTaken: 0 }, machine = { localErrors: 0, opportunitiesTaken: 0 };
  for (const f of findings.filter(x => x.status === 'verified-local')) {
    (f.actor === 'human' ? human : machine).localErrors++;
    if (f.exploited) (f.actor === 'human' ? machine : human).opportunitiesTaken++;
  }
  return { cases, review: { version: LEARNING_VERSION, validator: VALIDATOR_VERSION, gameId: r.id, fingerprint: recordFingerprint(r), completedAt: new Date().toISOString(),
    plies: r.moves.length, findings, metrics: { human, machine, candidates: findings.filter(x => x.status === 'candidate').length },
    limitations: ['双方逐手重验，不按输赢给每步贴标签；机会抓住数只统计实际应手与已验证反驳相同的情况。', '同格交换是有限估计；异地弃子补偿、复杂强制杀及开残局理论可能未覆盖。'] } };
}
export function summarizeReview(r: PostGameReview): ReviewSummary {
  return { gameId: r.gameId, plies: r.plies, completedAt: r.completedAt, verified: r.findings.filter(x => x.status === 'verified-local').length,
    candidates: r.metrics.candidates, humanErrors: r.metrics.human.localErrors, machineErrors: r.metrics.machine.localErrors };
}
export function recallExperience(p: Position, report: ExpertReport | undefined, cases: readonly TacticalCase[], overrides?: MoveReview[], limit = 3): ExperienceHint[] {
  if (!report || p.winner) return [];
  const hints: ExperienceHint[] = [], reviews = overrides ?? report.candidates, currentKey = boardIdentity(p);
  const push = (c: TacticalCase, match: ExperienceHint['match'], r: MoveReview) => {
    if (hints.some(x => x.caseId === c.id && x.match.endsWith(match.split('-').at(-1)!))) return;
    hints.push({ caseId: c.id, title: c.title, match, advice: match.endsWith('avoid') ? '比较当前候选的替代走法。' : '复核当前反击的具体收益。',
      sources: c.sources.slice(0, 3), sourceCount: c.sources.length, currentMove: r.move, currentLine: r.line, currentNet: r.estimatedNet,
      verification: 'rechecked-now', historicalLine: c.line, limitations: c.limitations });
  };
  // Small bounded retrieval: exact normalized boards first, then matching motifs
  // with a CURRENT computed witness. Similarity alone can never suggest a move.
  for (const c of cases.slice(-500)) {
    if (c.validator !== VALIDATOR_VERSION) continue;
    for (let i = 0; i < SYMMETRIES.length; i++) {
      const s = SYMMETRIES[i];
      if (currentKey === c.positionKeys.before[i]) {
        const r = reviewMove(p, transformMove(c.seed.mistake, s), { maxMs: 15, maxNodes: 1500 });
        if (localEvidence(p, r)) push(c, 'exact-avoid', r);
      }
      if (currentKey === c.positionKeys.after[i]) {
        const r = reviewMove(p, transformMove(c.seed.reply, s), { maxMs: 15, maxNodes: 1500 });
        if (fullEnough(r) && r.risk !== 'loss' && (r.terminal?.winner === p.next || r.estimatedNet >= 250)) push(c, 'exact-punish', r);
      }
    }
    if (hints.length >= limit) return hints.slice(0, limit);
  }
  const signals = reviews.filter(fullEnough).map(r => ({ r, motif: localEvidence(p, r) ? motifOf(p, r) : null,
    victim: at(p.board, r.move.to), attacker: at(p.board, r.move.from) }));
  for (const c of cases.slice(-100)) {
    if (c.validator !== VALIDATOR_VERSION) continue;
    for (const { r, motif, victim, attacker } of signals) {
      if (motif === c.motif) push(c, 'similar-avoid', r);
      if (victim && attacker?.kind === c.attackerKind && victim.kind === c.victimKind && r.estimatedNet >= 250 && r.risk !== 'loss') push(c, 'similar-punish', r);
      if (hints.length >= limit) return hints.slice(0, limit);
    }
  }
  return hints.slice(0, limit);
}
