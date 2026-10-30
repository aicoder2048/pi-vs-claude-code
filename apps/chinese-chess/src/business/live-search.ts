import { inCheck, other, play, same, type Position } from './engine';
import type { MoveReview } from './expert';
import { MATE_SCORE, type SearchOptions, type SearchReport } from './search';

// Requested depths are ceilings, never promises. Time and nodes are authoritative.
export const TURN_SEARCH_MS = 2600;
export const FINAL_SEARCH_MS = 700;
export const TURN_SEARCH_NODES = 70000;
export function liveSearchOptions(p: Position, remainingMs: number, requested: SearchOptions = {}): SearchOptions {
  const king = p.board.find(x => x?.color === p.next && x.kind === 'king');
  const pressure = inCheck(p.board, p.next) || !!king && p.board.some(x => x && x.color !== p.next
    && ['rook', 'cannon', 'horse'].includes(x.kind) && Math.abs(x.y - king.y) <= 3);
  return { maxMs: Math.max(0, Math.min(requested.maxMs ?? (pressure ? 900 : 550), remainingMs / 12, 1000)),
    maxNodes: Math.max(0, Math.min(requested.maxNodes ?? 20000, 30000)),
    maxDepth: Math.max(1, Math.min(requested.maxDepth ?? (pressure ? 5 : 4), 6)),
    quiescenceDepth: 4, extensions: 2, ...(requested.moves ? { moves: requested.moves } : {}) };
}

// A replayable PV alone is not a forced-loss proof. Require a mate-range root
// score from a completed minimax iteration as well; truncated roots never qualify.
export function mergeSearchReview(p: Position, review: MoveReview, search: SearchReport): MoveReview {
  const out = structuredClone(review); out.search = search;
  const candidate = search.candidates.find(c => same(c.move.from, review.move.from) && same(c.move.to, review.move.to));
  if (search.completedDepth < 1 || search.stopped === 'cancelled' || search.perspective !== p.next || !candidate) {
    out.warnings.push('多步搜索未完成所选走法的完整迭代，结果未知，不能视为安全。');
    return out;
  }
  if (candidate.score <= -MATE_SCORE + 100 && candidate.pv.length) {
    try {
      let q = p; for (const move of candidate.pv) q = play(q, move);
      if (q.winner === other(p.next)) {
        out.risk = 'loss'; out.score = candidate.score;
        out.line = candidate.line; out.variation = candidate.pv;
        out.bestReply = candidate.pv[1] ?? null;
        out.warnings.push('已完成的有界多步搜索发现规则判负路线；请改选或明确说明不可避免的败势。不是单步吃子估计。');
      }
    } catch { out.warnings.push('多步路线重放失败，未采用其胜负结论。'); }
  }
  return out;
}
