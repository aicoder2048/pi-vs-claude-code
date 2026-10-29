import { describe, expect, test } from 'bun:test';
import { analyze, boardText, coordinate, emptyPosition, index, play, replay, type Move, type Point } from '../src/business/engine';

function sequence(black: Point[], white: Point[]) {
  const moves: Move[] = [];
  black.forEach((p, i) => { moves.push({ ...p, color: 1 }); if (white[i]) moves.push({ ...white[i], color: 2 }); });
  return replay(moves);
}
describe('free gomoku rules', () => {
  test('15x15, black first, coordinates and replay consistency', () => {
    const initial = emptyPosition(); expect(initial.board).toHaveLength(225); expect(initial.next).toBe(1);
    const p = play(initial, { x: 7, y: 7 }); expect(p.board[index(7, 7)]).toBe(1); expect(p.next).toBe(2);
    expect(initial.moves).toHaveLength(0); expect(initial.board[index(7, 7)]).toBe(0);
    expect(replay(p.moves)).toEqual(p); expect(coordinate({ x: 0, y: 0 })).toBe('A15'); expect(coordinate({ x: 14, y: 14 })).toBe('O1');
    expect(boardText(p)).toContain('X');
  });
  test('rejects out-of-range, fractional, occupied, wrong color and non-finite coordinates', () => {
    for (const point of [{ x: -1, y: 0 }, { x: 15, y: 0 }, { x: 1.2, y: 0 }, { x: NaN, y: 1 }, { x: 1, y: Infinity }]) expect(() => play(emptyPosition(), point)).toThrow();
    const p = play(emptyPosition(), { x: 0, y: 0 });
    expect(() => play(p, { x: 0, y: 0 })).toThrow('已有棋子');
    expect(() => play(p, { x: 1, y: 0 }, 1)).toThrow('尚未轮到');
  });
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    test(`recognizes five, direction ${dx},${dy}, disallows post-win moves`, () => {
      const p = sequence(Array.from({ length: 5 }, (_, i) => ({ x: 3 + i * dx, y: 8 + i * dy })),
        Array.from({ length: 4 }, (_, i) => ({ x: i * 2, y: 0 })));
      expect(p.winner).toBe(1); expect(p.winningLine.length).toBeGreaterThanOrEqual(5);
      expect(() => play(p, { x: 14, y: 14 })).toThrow('结束'); expect(analyze(p).candidates).toEqual([]);
    });
  }
  test('white can win', () => {
    const p = sequence(Array.from({ length: 5 }, (_, i) => ({ x: i * 2, y: 0 })), Array.from({ length: 5 }, (_, i) => ({ x: i, y: 4 })));
    expect(p.winner).toBe(2);
  });
  test('allows overline formed by closing a gap', () => {
    const p = sequence([0, 1, 2, 4, 5, 3].map(x => ({ x, y: 7 })), [0, 2, 4, 6, 8].map(x => ({ x, y: 0 })));
    expect(p.winner).toBe(1); expect(p.winningLine).toHaveLength(6);
  });
  test('full-board draw with no five (two-by-two stripes)', () => {
    const black: Point[] = [], white: Point[] = [];
    for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) ((x + Math.floor(y / 2)) % 2 === 0 ? black : white).push({ x, y });
    expect(black.length).toBe(113); expect(white.length).toBe(112);
    const p = sequence(black, white); expect(p.winner).toBe('draw'); expect(p.moves).toHaveLength(225);
  });
});
describe('calculation on canonical record', () => {
  test('empty board suggests center without mutating position', () => {
    const p = emptyPosition(), before = structuredClone(p), a = analyze(p);
    expect(a.candidates[0]).toMatchObject({ x: 7, y: 7 }); expect(p).toEqual(before);
  });
  test('detects both ends of open four and mandatory blocks', () => {
    const p = sequence([3, 4, 5, 6].map(x => ({ x, y: 7 })), [0, 2, 4].map(x => ({ x, y: 0 })));
    const a = analyze(p); expect(a.mustBlock).toEqual([{ x: 2, y: 7 }, { x: 7, y: 7 }]);
    expect(a.candidates[0].tags).toContain('阻止成五'); expect(a.ply).toBe(7);
  });
  test('detects broken-four immediate win', () => {
    const p = sequence([3, 4, 6, 7].map(x => ({ x, y: 7 })), [0, 2, 4, 6].map(x => ({ x, y: 0 })));
    expect(analyze(p).winningMoves).toContainEqual({ x: 5, y: 7 });
    expect(analyze(p).candidates[0]).toMatchObject({ x: 5, y: 7 });
  });
  test('no row wrapping or false five at board edges', () => {
    const p = sequence([{ x: 13, y: 4 }, { x: 14, y: 4 }, { x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }],
      [0, 2, 4, 6].map(x => ({ x, y: 0 })));
    expect(p.winner).toBeNull();
  });
});
