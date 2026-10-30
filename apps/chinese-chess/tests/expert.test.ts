import { describe, expect, test } from 'bun:test';
import { at, emptyPosition, legalCapturesTo, legalMoves, other, play, positionFromPieces, replay, same, type Color, type Kind, type MoveInput, type Piece } from '../src/business/engine';
import { analyzeExpert, compareMoves, inspectSafety, needsRiskAcknowledgement, phaseOf, pieceValue, reviewMove } from '../src/business/expert';
import { RECORDED_GAME } from './fixtures/recorded-game';
const full = { maxMs: 10000, maxNodes: 50000 };
const m = (x: number, y: number, a: number, b: number): MoveInput => ({ from: { x, y }, to: { x: a, y: b } });
const piece = (kind: Kind, color: Color, x: number, y: number): Piece => ({ id: `${color}-${kind}-${x}-${y}`, kind, color, x, y });
const board = (extra: Piece[], next: Color = 1) => positionFromPieces([piece('king', 1, 4, 9), piece('king', 2, 4, 0), piece('pawn', 1, 4, 5), ...extra], next);

describe('real game blunder regressions (portable coordinates, no user profile needed)', () => {
  test('original 71 plies replay to red checkmate', () => { expect(replay(RECORDED_GAME)).toMatchObject({ winner: 1, endReason: 'checkmate' }); });
  test('ply 42: rejects the story “attack their rook” when actually giving away our rook', () => {
    const p = replay(RECORDED_GAME.slice(0, 41)), r = reviewMove(p, RECORDED_GAME[41], full);
    expect(r.risk).toBe('material-loss'); expect(r.estimatedNet).toBe(-900);
    expect(r.bestReply).toEqual(RECORDED_GAME[42]); expect(r.line[1]).toContain('红车 B0 → B2 吃车');
    expect(r.coverage.complete).toBe(true); expect(needsRiskAcknowledgement(r)).toBe(true);
  });
  test('ply 44: pawn reward no longer hides a hanging cannon', () => {
    const p = replay(RECORDED_GAME.slice(0, 43)), r = reviewMove(p, RECORDED_GAME[43], full);
    expect(r.immediateGain).toBe(100); expect(r.estimatedNet).toBe(-350);
    expect(r.risk).toBe('material-loss'); expect(r.bestReply).toEqual(RECORDED_GAME[44]);
    const comparison = compareMoves(p, [RECORDED_GAME[43], m(3, 6, 2, 6)], full);
    expect(comparison[0].move).toEqual(m(3, 6, 2, 6));
  });
  test('expert report prioritizes actual threats and keeps full legal moves available', () => {
    const p = replay(RECORDED_GAME.slice(0, 43)); const a = analyzeExpert(p, full);
    expect(a.expert!.safety.some(x => x.id === '2-cannon-1' && x.legalAttackers.length)).toBe(true);
    expect(a.expert!.principles.map(x => x.id)).toContain('cannon-screen');
    expect(a.legalMoves).toEqual(legalMoves(p)); expect(a.expert!.candidates[0].estimatedNet).toBeGreaterThan(-350);
  });
});
describe('tactical facts versus heuristic expert advice', () => {
  test('rook takes poisoned pawn: bounded exchange sees net loss, not +100', () => {
    const p = board([piece('rook', 1, 0, 7), piece('pawn', 2, 0, 4), piece('rook', 2, 0, 0)]);
    const r = reviewMove(p, m(0, 7, 0, 4), full); expect(r.estimatedNet).toBe(-800); expect(r.risk).toBe('material-loss');
  });
  test('legal recapture chain accounts for protection instead of forbidding all attacked squares', () => {
    const p = board([piece('rook', 1, 0, 7), piece('rook', 1, 1, 4), piece('horse', 2, 0, 4), piece('rook', 2, 0, 0)]);
    const r = reviewMove(p, m(0, 7, 0, 4), full);
    expect(r.estimatedNet).toBeGreaterThanOrEqual(0); expect(needsRiskAcknowledgement(r)).toBe(false);
  });
  test('geometric defender pinned to king cannot legally recapture', () => {
    const p = positionFromPieces([piece('king', 1, 4, 9), piece('king', 2, 3, 0), piece('rook', 2, 4, 0), piece('rook', 1, 4, 4), piece('horse', 1, 2, 6), piece('pawn', 2, 3, 3)]);
    expect(inspectSafety(p).find(x => x.square.x === 4 && x.square.y === 4)?.pinnedToKing).toBe(true);
    const q = play(p, m(2, 6, 3, 4));
    expect(inspectSafety(q).find(x => x.square.x === 3 && x.square.y === 4)?.geometricDefenders).toContain('红车@E4');
    const after = play(q, m(3, 3, 3, 4)); expect(legalCapturesTo(after, { x: 3, y: 4 })).toEqual([]);
  });
  test('horse legs and cannon screens use the same legal rule module, not approximate counts', () => {
    const p = board([piece('horse', 1, 2, 6), piece('pawn', 1, 2, 5), piece('rook', 2, 3, 4)]);
    expect(legalCapturesTo(p, { x: 3, y: 4 })).toEqual([]);
    const q = board([piece('cannon', 1, 0, 7), piece('rook', 2, 0, 2)]);
    expect(legalCapturesTo(q, { x: 0, y: 2 })).toEqual([]);
    const s = board([piece('cannon', 1, 0, 7), piece('pawn', 1, 0, 5), piece('rook', 2, 0, 2)]);
    expect(legalCapturesTo(s, { x: 0, y: 2 })).toEqual([m(0, 7, 0, 2)]);
  });
  test('an opponent immediate mate is a verified counterexample, not just a negative score', () => {
    const p = board([piece('rook', 1, 3, 1), piece('rook', 1, 5, 1), piece('rook', 1, 0, 2), piece('horse', 2, 8, 0)], 2);
    const r = reviewMove(p, m(8, 0, 7, 2), full);
    expect(r.risk).toBe('loss'); expect(r.losingReply?.reason).toBe('checkmate');
    expect(play(play(p, r.move), r.losingReply!.move).winner).toBe(1);
  });
  test('actual checkmate and stalemate win take precedence over material danger', () => {
    const p = board([piece('rook', 1, 3, 1), piece('rook', 1, 5, 1), piece('rook', 1, 0, 2)]);
    const r = reviewMove(p, m(0, 2, 4, 2), full); expect(r.risk).toBe('win'); expect(needsRiskAcknowledgement(r)).toBe(false);
    const q = board([piece('rook', 1, 3, 1), piece('rook', 1, 5, 1), piece('horse', 1, 0, 9)]);
    expect(reviewMove(q, m(0, 9, 1, 7), full).terminal?.reason).toBe('stalemate');
    expect(analyzeExpert(p, { ...full, candidateLimit: 4 }).expert!.candidates[0].risk).toBe('win');
  });
  test('phase-specific advice is grounded in actual board features', () => {
    const a = analyzeExpert(emptyPosition(), full); expect(a.expert?.phase).toBe('opening');
    expect(a.expert!.principles.map(x => x.id)).toContain('development');
    const p = board([piece('horse', 1, 0, 5), piece('cannon', 2, 8, 5)]);
    expect(phaseOf(p)).toBe('endgame'); expect(pieceValue(piece('horse', 1, 0, 5), 'endgame')).toBeGreaterThan(pieceValue(piece('cannon', 1, 0, 5), 'endgame'));
    expect(analyzeExpert(p, full).expert!.principles.map(x => x.id)).toContain('endgame');
  });
  test('rotating board and swapping colors preserves risk and exchange result', () => {
    const p = board([piece('rook', 1, 0, 7), piece('pawn', 2, 0, 4), piece('rook', 2, 0, 0)]);
    const q = positionFromPieces(p.board.filter(Boolean).map(x => ({ ...x!, x: 8 - x!.x, y: 9 - x!.y, color: other(x!.color) })), 2);
    const a = reviewMove(p, m(0, 7, 0, 4), full), b = reviewMove(q, m(8, 2, 8, 5), full);
    expect(a.risk).toBe(b.risk); expect(a.estimatedNet).toBe(b.estimatedNet); expect(a.score).toBe(b.score);
  });
  test('zero budget and depth truncation are unknown, not a safety certificate; no mutation', () => {
    const p = emptyPosition(), before = structuredClone(p), move = m(0, 6, 0, 5);
    const r = reviewMove(p, move, { maxNodes: 0, maxMs: 10000 }); expect(r.risk).toBe('uncertain'); expect(r.coverage.checkedReplies).toBe(0);
    expect(r.coverage.complete).toBe(false); expect(r.warnings.join('')).toContain('未知'); expect(p).toEqual(before);
    const limited = reviewMove(p, move, { maxNodes: 5, maxMs: 10000 }); expect(limited.coverage.nodes).toBeLessThanOrEqual(5);
    expect(() => compareMoves(p, [], full)).toThrow(); expect(() => compareMoves(p, Array(7).fill(move), full)).toThrow();
    expect(() => reviewMove(p, m(0, 6, 1, 6), full)).toThrow(); expect(p).toEqual(before);
  });
  test('exchange depth truncation is explicit even if every immediate reply was examined', () => {
    const p = board([piece('rook', 1, 0, 7), piece('rook', 1, 1, 4), piece('horse', 2, 0, 4), piece('rook', 2, 0, 0)]);
    const r = reviewMove(p, m(0, 7, 0, 4), { ...full, exchangeDepth: 0 });
    expect(r.coverage.complete).toBe(true); expect(r.coverage.exchangeComplete).toBe(false);
    expect(r.warnings.join('')).toContain('未知');
  });
  test('all reported counterexample variations are actually replayable', () => {
    for (const ply of [13, 15, 17, 41, 43]) {
      const p = replay(RECORDED_GAME.slice(0, ply));
      for (const r of analyzeExpert(p, full).expert!.candidates) {
        const q = play(p, r.move);
        if (r.bestReply) expect(() => play(q, r.bestReply!)).not.toThrow();
        expect(r.coverage.checkedReplies).toBeLessThanOrEqual(r.coverage.totalReplies);
      }
    }
  });
});
