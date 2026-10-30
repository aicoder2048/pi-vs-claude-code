import { describe, expect, test } from 'bun:test';
import { emptyPosition, play, positionFromPieces, replay, type Color, type Kind, type Piece } from '../src/business/engine';
import { evaluatePosition } from '../src/business/evaluation';
import { analyzeExpert } from '../src/business/expert';
import { planForPosition, updatePlan, type PlanUpdate } from '../src/business/plan';
import { PASSIVE_GAME } from './fixtures/passive-game';
const piece = (kind: Kind, color: Color, x: number, y: number): Piece => ({ id: `${color}-${kind}-${x}-${y}`, kind, color, x, y });
const draft: PlanUpdate = { action: 'revise', reason: '优先解除牵制，让闲置车炮加入战斗。',
  objective: '疏通左车并协调车炮', problem: '左车闲置，中路子力相互牵制', opponentThreat: '对手可能沉底炮并调双车转肋',
  nextSteps: ['先核查对方直接杀棋', '择机调炮疏通车路'], abandonWhen: '对方形成直接杀棋或当前变化不再成立' };

describe('small, grounded positional terms', () => {
  test('actual passive game reports idle rook/cannon and accumulating constraints', () => {
    const p = replay(PASSIVE_GAME.slice(0, 29)), e = evaluatePosition(p, 2, 'middlegame');
    expect(e.inactiveMajors).toContain('黑车@A0'); expect(e.inactiveMajors).toContain('黑炮@B2'); expect(e.development).toBeLessThan(0);
    const a = analyzeExpert(p).expert!;
    expect(a.position.black).toEqual(e); expect(a.principles.map(x => x.id)).toContain('activate-idle-pieces');
    const late = evaluatePosition(replay(PASSIVE_GAME.slice(0, 47)), 2, 'middlegame');
    expect(late.kingLineConstraints.length).toBeGreaterThan(0);
  });
  test('cannon pressure needs a screen; two pieces on a target add bounded coordination', () => {
    const base = [piece('king', 1, 4, 9), piece('king', 2, 4, 0), piece('pawn', 1, 4, 5), piece('cannon', 1, 0, 1)];
    const noScreen = evaluatePosition(positionFromPieces(base), 1, 'middlegame');
    const screened = evaluatePosition(positionFromPieces([...base, piece('pawn', 1, 2, 1)]), 1, 'middlegame');
    const paired = evaluatePosition(positionFromPieces([...base, piece('pawn', 1, 2, 1), piece('rook', 1, 5, 3)]), 1, 'middlegame');
    expect(noScreen.kingPressure).toBe(0); expect(screened.kingPressure).toBeGreaterThan(0);
    expect(paired.coordination).toBeGreaterThan(screened.coordination); expect(paired.kingPressure).toBeLessThanOrEqual(70); expect(paired.coordination).toBeLessThanOrEqual(54);
  });
  test('king-line pin burden uses the actual king safety rule', () => {
    const p = positionFromPieces([piece('king', 1, 4, 9), piece('king', 2, 3, 0), piece('rook', 2, 4, 0), piece('rook', 1, 4, 4)]);
    const e = evaluatePosition(p, 1, 'middlegame'); expect(e.kingLineConstraints).toContain('红车@E4'); expect(e.constraints).toBeLessThan(0);
  });
  test('quiet back-and-forth is a small cost, not a hard prohibition', () => {
    const p = replay([{ from: { x: 1, y: 9 }, to: { x: 2, y: 7 } }, { from: { x: 1, y: 0 }, to: { x: 2, y: 2 } },
      { from: { x: 2, y: 7 }, to: { x: 1, y: 9 } }, { from: { x: 2, y: 2 }, to: { x: 1, y: 0 } }]);
    const e = evaluatePosition(p, 1, 'opening'); expect(e.wastedTempo).toBe(-8); expect(e.repeatedMoves).toHaveLength(1);
    expect(e.total).toBe(e.development + e.mobility + e.coordination + e.kingPressure + e.constraints + e.wastedTempo);
  });
});

describe('structured plans are conditional, bounded and branch-safe', () => {
  test('revise, explicitly recheck after an opponent move, continue, abandon', () => {
    const p = emptyPosition(), plan = updatePlan(p, null, draft)!;
    expect(plan.color).toBe(1); expect(plan.status).toBe('active'); expect(plan.expiresAtPly).toBe(8);
    const q = replay([{ from: { x: 0, y: 6 }, to: { x: 0, y: 5 } }, { from: { x: 0, y: 3 }, to: { x: 0, y: 4 } }]);
    const pending = planForPosition(plan, q)!; expect(pending.status).toBe('needs-review'); expect(plan.status).toBe('active');
    const renewed = updatePlan(q, pending, { action: 'continue', reason: '对方挺卒未改变车炮协调的目标。', opponentThreat: '留意边卒推进，不影响当前解围' })!;
    expect(renewed.createdPly).toBe(0); expect(renewed.reviewedPly).toBe(2); expect(renewed.expiresAtPly).toBe(10);
    expect(renewed.opponentThreat).toContain('边卒');
    expect(updatePlan(q, renewed, { action: 'abandon', reason: '现有路线不再成立，放弃旧计划。' })?.status).toBe('abandoned');
  });
  test('opponent check, capture, terminal and TTL invalidate old intentions', () => {
    const p = replay(PASSIVE_GAME.slice(0, 40)); const plan = updatePlan(replay(PASSIVE_GAME.slice(0, 39)), null, draft)!;
    const check = planForPosition(plan, play(p, PASSIVE_GAME[40]))!; expect(check.status).toBe('invalidated');
    expect(() => updatePlan(play(p, PASSIVE_GAME[40]), check, { action: 'continue', reason: '仍执行旧计划' })).toThrow();
    const beforeCapture = replay(PASSIVE_GAME.slice(0, 42)), blackPlan = updatePlan(replay(PASSIVE_GAME.slice(0, 41)), null, draft)!;
    expect(planForPosition(blackPlan, play(beforeCapture, PASSIVE_GAME[42]))?.status).toBe('invalidated');
    const initial = emptyPosition(), expired = { ...updatePlan(initial, null, draft)!, expiresAtPly: 0 };
    expect(planForPosition(expired, initial)?.status).toBe('invalidated');
    expect(() => updatePlan(initial, expired, { action: 'continue', reason: '继续过期计划' })).toThrow();
    expect(planForPosition(plan, replay(PASSIVE_GAME))?.status).toBe('invalidated');
  });
  test('schema is validated by the domain, not just by model tool arguments', () => {
    expect(() => updatePlan(emptyPosition(), null, { action: 'continue', reason: '继续原计划' })).toThrow();
    expect(() => updatePlan(emptyPosition(), null, { ...draft, objective: '' })).toThrow();
    expect(() => updatePlan(emptyPosition(), null, { ...draft, nextSteps: [] })).toThrow();
    expect(() => updatePlan(emptyPosition(), null, { ...draft, nextSteps: Array(4).fill('疏通车路') })).toThrow();
    expect(() => updatePlan(emptyPosition(), null, { ...draft, reason: 'x'.repeat(161) })).toThrow();
    expect(() => updatePlan(emptyPosition(), null, { ...draft, action: 'execute' } as any)).toThrow();
  });
});
