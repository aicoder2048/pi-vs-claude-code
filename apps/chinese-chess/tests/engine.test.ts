import { describe, expect, test } from 'bun:test';
import { analyze, at, emptyPosition, inCheck, legalMoves, play, positionFromPieces, replay, type Color, type Kind, type MoveInput, type Piece, type Position } from '../src/business/engine';
const m = (x: number, y: number, a: number, b: number): MoveInput => ({ from: { x, y }, to: { x: a, y: b } });
const piece = (kind: Kind, color: Color, x: number, y: number): Piece => ({ id: `${color}-${kind}-${x}-${y}`, kind, color, x, y });
function board(extra: Piece[], next: Color = 1): Position {
  return positionFromPieces([piece('king', 1, 4, 9), piece('king', 2, 4, 0), piece('pawn', 1, 4, 5), ...extra], next);
}
const can = (p: Position, move: MoveInput) => legalMoves(p, move.from).some(x => JSON.stringify(x) === JSON.stringify(move));
describe('Xiangqi complete movement and king safety', () => {
  test('32-piece starting array, 44 legal moves and known perft(2)=1920', () => {
    const p = emptyPosition(); expect(p.board.filter(Boolean)).toHaveLength(32); expect(p.next).toBe(1);
    expect(legalMoves(p)).toHaveLength(44);
    expect(legalMoves(p).reduce((sum, move) => sum + legalMoves(play(p, move)).length, 0)).toBe(1920);
    expect(analyze(p).redScore).toBe(analyze(p).blackScore);
  });
  test('rooks cannot jump, move diagonally or eat their own side', () => {
    const p = emptyPosition(); expect(can(p, m(0, 9, 0, 7))).toBe(true);
    for (const move of [m(0, 9, 0, 5), m(0, 9, 1, 8), m(0, 9, 1, 9)]) expect(() => play(p, move)).toThrow();
  });
  test('horse legs independently block the corresponding L moves', () => {
    const p = board([piece('horse', 1, 2, 6), piece('pawn', 1, 2, 5)]);
    expect(can(p, m(2, 6, 1, 4))).toBe(false); expect(can(p, m(2, 6, 3, 4))).toBe(false);
    expect(can(p, m(2, 6, 0, 5))).toBe(true); expect(can(p, m(2, 6, 3, 8))).toBe(true);
  });
  test('elephant eyes, river boundary and both colors', () => {
    expect(can(board([piece('elephant', 1, 2, 7)]), m(2, 7, 0, 5))).toBe(true);
    expect(can(board([piece('elephant', 1, 2, 7), piece('pawn', 1, 1, 6)]), m(2, 7, 0, 5))).toBe(false);
    expect(can(board([piece('elephant', 1, 2, 5)]), m(2, 5, 0, 3))).toBe(false);
    expect(can(board([piece('elephant', 2, 2, 4)], 2), m(2, 4, 0, 6))).toBe(false);
  });
  test('advisors remain in palace, kings cannot leave palace', () => {
    const p = board([piece('advisor', 1, 3, 9)]);
    expect(can(p, m(3, 9, 4, 8))).toBe(true); expect(can(p, m(3, 9, 2, 8))).toBe(false);
    expect(can(p, m(4, 9, 4, 8))).toBe(true);
    const q = positionFromPieces([piece('king', 1, 3, 7), piece('king', 2, 4, 0)]);
    expect(can(q, m(3, 7, 3, 6))).toBe(false); expect(can(q, m(3, 7, 2, 7))).toBe(false);
  });
  test('cannon needs exactly one screen to capture, no screen to move', () => {
    const p = board([piece('cannon', 1, 0, 7), piece('pawn', 1, 0, 5), piece('rook', 2, 0, 2)]);
    expect(can(p, m(0, 7, 0, 6))).toBe(true); expect(can(p, m(0, 7, 0, 4))).toBe(false);
    const q = play(p, m(0, 7, 0, 2)); expect(q.moves[0].captured?.kind).toBe('rook'); expect(at(q.board, { x: 0, y: 7 })).toBeNull();
    expect(can(board([piece('cannon', 1, 0, 7), piece('rook', 2, 0, 2)]), m(0, 7, 0, 2))).toBe(false);
    expect(can(board([piece('cannon', 1, 0, 7), piece('pawn', 1, 0, 5), piece('pawn', 2, 0, 4), piece('rook', 2, 0, 2)]), m(0, 7, 0, 2))).toBe(false);
  });
  test('pawns advance, may go sideways only across river, never retreat', () => {
    const p = board([piece('pawn', 1, 0, 6), piece('pawn', 1, 2, 4), piece('pawn', 2, 6, 5)]);
    expect(can(p, m(0, 6, 0, 5))).toBe(true); expect(can(p, m(0, 6, 1, 6))).toBe(false);
    expect(can(p, m(2, 4, 3, 4))).toBe(true); expect(can(p, m(2, 4, 2, 5))).toBe(false);
    expect(can({ ...p, next: 2 }, m(6, 5, 7, 5))).toBe(true); expect(can({ ...p, next: 2 }, m(6, 5, 6, 4))).toBe(false);
  });
  test('flying generals and pinned pieces cannot expose own king', () => {
    const p = positionFromPieces([piece('king', 1, 4, 9), piece('king', 2, 4, 0), piece('pawn', 1, 4, 4)]);
    expect(() => play(p, m(4, 4, 5, 4))).toThrow('照面');
    const q = board([piece('rook', 2, 0, 9), piece('rook', 1, 2, 9)]);
    expect(can(q, m(2, 9, 2, 8))).toBe(false); expect(can(q, m(2, 9, 0, 9))).toBe(true);
  });
  test('check must be answered; horse and cannon checks are detected', () => {
    const p = board([piece('rook', 2, 3, 9), piece('horse', 1, 0, 7)]);
    expect(inCheck(p.board, 1)).toBe(true); expect(can(p, m(0, 7, 1, 5))).toBe(false);
    expect(inCheck(board([piece('horse', 2, 3, 7)]).board, 1)).toBe(true);
    expect(inCheck(board([piece('cannon', 2, 4, 2)]).board, 1)).toBe(true);
  });
  test('checkmate AND stalemate are losses, not western-chess draws', () => {
    const p = board([piece('rook', 1, 3, 1), piece('rook', 1, 5, 1), piece('rook', 1, 0, 2)]);
    expect(play(p, m(0, 2, 4, 2))).toMatchObject({ winner: 1, endReason: 'checkmate' });
    const q = board([piece('rook', 1, 3, 1), piece('rook', 1, 5, 1), piece('horse', 1, 0, 9)]);
    expect(play(q, m(0, 9, 1, 7))).toMatchObject({ winner: 1, endReason: 'stalemate' });
  });
  test('ordinary threefold repetition draws; unilateral perpetual check loses', () => {
    let p = emptyPosition();
    const cycle = [m(1, 9, 2, 7), m(1, 0, 2, 2), m(2, 7, 1, 9), m(2, 2, 1, 0)];
    for (const move of [...cycle, ...cycle]) p = play(p, move);
    expect(p).toMatchObject({ winner: 'draw', endReason: 'repetition' });
    let q = board([piece('rook', 1, 5, 1)]);
    const checking = [m(5, 1, 4, 1), m(4, 0, 5, 0), m(4, 1, 5, 1), m(5, 0, 4, 0)];
    for (const move of [...checking, ...checking]) q = play(q, move);
    expect(q).toMatchObject({ winner: 2, endReason: 'perpetual-check' });
  });
  test('120 quiet half-moves draw, pawn movement and capture reset counter', () => {
    const p = { ...emptyPosition(), quietPlies: 119 };
    expect(play(p, m(1, 9, 2, 7))).toMatchObject({ winner: 'draw', endReason: 'no-progress' });
    expect(play(p, m(0, 6, 0, 5)).quietPlies).toBe(0);
    expect(play(p, m(1, 7, 1, 0)).quietPlies).toBe(0);
  });
  test('malformed coordinates, wrong turns and postgame moves rejected without mutation', () => {
    const p = emptyPosition(), original = JSON.stringify(p);
    for (const move of [m(0, 3, 0, 4), m(0, 6, -1, 6), m(0, 6, .5, 5), m(0, 6, 0, 10)]) expect(() => play(p, move)).toThrow();
    expect(() => play(p, null as any)).toThrow(); expect(JSON.stringify(p)).toBe(original);
    expect(() => play({ ...p, winner: 1 }, m(0, 6, 0, 5))).toThrow('结束');
  });
  test('deterministic full replay preserves all positions, captures, legal kings and IDs', () => {
    let p = emptyPosition();
    for (let i = 0; i < 60 && !p.winner; i++) {
      const moves = legalMoves(p); const move = moves[(i * 23 + 7) % moves.length]; const color = p.next;
      p = play(p, move); expect(inCheck(p.board, color)).toBe(false);
      expect(new Set(p.board.filter(Boolean).map(p => p!.id)).size).toBe(p.board.filter(Boolean).length);
    }
    expect(replay(p.moves)).toEqual(p);
  });
});
