import { describe, expect, test } from 'bun:test';
import { emptyPosition, play, replay } from '../src/business/engine';
import { lastMoveHighlight } from '../src/renderer/last-move';
import { CANNON_TRAP_GAME } from './fixtures/cannon-trap-game';

const pawn = { from: { x: 0, y: 6 }, to: { x: 0, y: 5 } };
describe('persistent last-move guide', () => {
  test('initial board has no stale origin, destination or arrow', () => {
    expect(lastMoveHighlight(emptyPosition(), 1)).toBeNull();
  });
  test('adjacent move has separated origin and destination, with arrow outside piece', () => {
    const p = play(emptyPosition(), pawn), before = structuredClone(p);
    const h = lastMoveHighlight(p, 1)!;
    expect(h.from).toEqual({ x: 50, y: 650 }); expect(h.to).toEqual({ x: 50, y: 550 });
    expect(h.path).toBe('M50 620 L50 606');
    expect(h.caption).toBe('最近一步 · 你 · 红兵 A6 → A5 · 第 1 手'); expect(p).toEqual(before);
    expect(lastMoveHighlight(p, 1)).toEqual(h); // no timer, focus or animation dependency
  });
  test('flipping rotates guide but NEVER rewrites business coordinates or actor', () => {
    const p = play(emptyPosition(), pawn), h = lastMoveHighlight(p, 2, true)!;
    expect(h.from).toEqual({ x: 850, y: 350 }); expect(h.to).toEqual({ x: 850, y: 450 });
    expect(h.path).toBe('M850 380 L850 394');
    expect(h.caption).toContain('LLM · 红兵 A6 → A5');
    expect(lastMoveHighlight(p, 2, false)?.caption).toBe(h.caption);
  });
  test('black move, capture and historical ply describe the displayed board, not latest live move', () => {
    const live = replay(CANNON_TRAP_GAME.slice(0, 12));
    const history = replay(live.moves.slice(0, 11));
    const h = lastMoveHighlight(history, 2, false, true)!;
    expect(h.caption).toBe('回看此步 · LLM · 红炮 I5 → I2 吃车 · 第 11 手');
    expect(h.from).toEqual({ x: 850, y: 550 }); expect(h.to).toEqual({ x: 850, y: 250 });
    expect(lastMoveHighlight(live, 1)?.caption).toContain('LLM · 黑象 G0 → I2 吃炮 · 第 12 手');
  });
  test('horse diagonal keeps the direction and trims both ends consistently', () => {
    const p = replay(CANNON_TRAP_GAME.slice(0, 2)), h = lastMoveHighlight(p, 1)!;
    expect(h.from).toEqual({ x: 150, y: 50 }); expect(h.to).toEqual({ x: 250, y: 250 });
    const [sx, sy, ex, ey] = h.path.slice(1).split(/ L| /).map(Number);
    expect(Math.hypot(sx - h.from.x, sy - h.from.y)).toBeCloseTo(30);
    expect(Math.hypot(ex - h.to.x, ey - h.to.y)).toBeCloseTo(56);
    expect(ex).toBeGreaterThan(sx); expect(ey).toBeGreaterThan(sy);
  });
  test('undo and next move recompute the guide rather than retaining an old machine move', () => {
    const p = replay(CANNON_TRAP_GAME.slice(0, 4));
    expect(lastMoveHighlight(p, 1)?.caption).toContain('第 4 手');
    expect(lastMoveHighlight(replay(p.moves.slice(0, 3)), 1)?.caption).toContain('你 · 红马');
    expect(lastMoveHighlight(replay([]), 1)).toBeNull();
  });
});
