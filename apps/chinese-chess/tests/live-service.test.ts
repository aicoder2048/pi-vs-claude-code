import { describe, expect, test } from 'bun:test';
import { GameService, type AgentDriver, type TurnPort } from '../src/business/game-service';
import { MoveRiskError } from '../src/business/expert';
import { DEFAULT_SETTINGS } from '../src/business/clock';
import { TURN_SEARCH_MS, TURN_SEARCH_NODES } from '../src/business/live-search';
import { searchPosition, type SearchDriver, type SearchOptions, type SearchReport } from '../src/business/search';
import type { PlanUpdate } from '../src/business/plan';
import type { Position } from '../src/business/engine';
import { PASSIVE_GAME } from './fixtures/passive-game';
const model = { provider: 'test', id: 'live', name: 'Live search fixture' };
const red = { from: { x: 0, y: 6 }, to: { x: 0, y: 5 } }, black = { from: { x: 0, y: 3 }, to: { x: 0, y: 4 } };
const draft: PlanUpdate = { action: 'revise', reason: '先疏通车路，必要时转入防守。', objective: '协调车炮并解除牵制', problem: '闲置子力尚未参加战斗',
  opponentThreat: '对手可能组织车炮攻势', nextSteps: ['先检查直接杀棋', '择机疏通车路'], abandonWhen: '对手制造直接杀棋或交换改变结构' };
class Driver implements AgentDriver { turns: TurnPort[] = []; async run(port: TurnPort) { this.turns.push(port); await new Promise<void>(() => {}); } }
const unknown = (p: Position) => searchPosition(p, { maxMs: 0, maxNodes: 0 });
function harness(search: SearchDriver = { async search(p) { return unknown(p); } }) {
  let now = 0; const driver = new Driver();
  const service = new GameService(driver, model, { search, now: () => now, settings: { ...DEFAULT_SETTINGS, allowUndo: true } });
  service.humanMove(red, 0);
  return { service, driver, port: driver.turns[0], advance(ms: number) { now += ms; } };
}
function deferredSearch() {
  let done!: (report: SearchReport) => void, position!: Position;
  const driver: SearchDriver = { search(p) { position = p; return new Promise(resolve => { done = resolve; }); } };
  return { driver, finish() { done(unknown(position)); } };
}

describe('authoritative asynchronous search and commits', () => {
  test('every submitted move gets an independent scoped search and saved coverage', async () => {
    const calls: SearchOptions[] = [], h = harness({ async search(p, options) { calls.push(options); return unknown(p); } });
    await h.port.commit(black, '挺卒争河界。');
    expect(calls).toHaveLength(1); expect(calls[0].moves).toEqual([black]);
    expect(h.service.record().notes[0].review?.search?.completedDepth).toBe(0);
    expect(h.service.record().notes[0].review?.warnings.join('')).toContain('未知'); h.service.dispose();
  });
  test('optional searches cannot consume the final-review reserve or exceed turn caps', async () => {
    const calls: SearchOptions[] = [], h = harness({ async search(p, options) { calls.push(options); return unknown(p); } });
    for (let i = 0; i < 6; i++) await h.port.search!({ maxMs: 1000, maxNodes: 30000 });
    await h.port.commit(black, '预算用尽后仍须复查实际走法。');
    expect(calls.reduce((s, x) => s + x.maxMs!, 0)).toBeLessThanOrEqual(TURN_SEARCH_MS);
    expect(calls.reduce((s, x) => s + x.maxNodes!, 0)).toBeLessThanOrEqual(TURN_SEARCH_NODES);
    expect(calls.at(-1)!.maxMs).toBeGreaterThan(0); expect(calls.at(-1)!.maxNodes).toBeGreaterThan(0); h.service.dispose();
  });
  test('cancel/new-game/model-change/undo invalidate a pending final search without a late commit', async () => {
    for (const invalidate of [(s: GameService) => s.cancel(), (s: GameService) => s.newGame(1), (s: GameService) => s.setModel(model), (s: GameService) => s.undo()]) {
      const d = deferredSearch(), h = harness(d.driver); h.port.updatePlan!(draft);
      const work = h.port.commit(black, '计算中应可取消。');
      invalidate(h.service); d.finish(); await expect(work).rejects.toThrow();
      expect(h.service.snapshot().position.moves.length).toBeLessThanOrEqual(1); expect(h.service.snapshot().notes).toHaveLength(0);
      expect(h.service.snapshot().plan).toBeNull(); h.service.dispose();
    }
  });
  test('clock expiry during asynchronous search wins, without a heartbeat', async () => {
    const d = deferredSearch(), h = harness(d.driver), work = h.port.commit(black, '搜索期间仍然计时。');
    h.advance(DEFAULT_SETTINGS.mainTimeMs); d.finish(); await expect(work).rejects.toThrow('棋钟耗尽');
    expect(h.service.snapshot().outcome).toMatchObject({ winner: 1, reason: 'main-time' });
    expect(h.service.snapshot().notes).toHaveLength(0); expect(h.service.snapshot().position.moves).toHaveLength(1); h.service.dispose();
  });
  test('concurrent commits/search/plan changes cannot race an in-flight final review', async () => {
    const d = deferredSearch(), h = harness(d.driver), work = h.port.commit(black, '正在复查。');
    await expect(h.port.commit(black, '重复提交。')).rejects.toThrow('并发');
    await expect(h.port.search!()).rejects.toThrow(); expect(() => h.port.updatePlan!(draft)).toThrow();
    d.finish(); await work; expect(h.service.snapshot().position.moves).toHaveLength(2); h.service.dispose();
  });
  test('tool cancellation cannot finish a late move while the game itself remains active', async () => {
    const d = deferredSearch(), h = harness(d.driver), operation = new AbortController();
    const work = h.port.commit(black, '工具取消后不能继续落子。', undefined, operation.signal);
    operation.abort(); d.finish(); await expect(work).rejects.toThrow('取消');
    expect(h.port.signal.aborted).toBe(false); expect(h.service.snapshot().position.moves).toHaveLength(1);
    expect(h.service.snapshot().notes).toHaveLength(0); expect(h.service.snapshot().clock.running).toBe(2); h.service.dispose();
  });
  test('coordinates cannot be changed while the independent asynchronous review is running', async () => {
    const d = deferredSearch(), h = harness(d.driver), proposal = structuredClone(black);
    const work = h.port.commit(proposal, '提交坐标必须固定。'); proposal.to = { x: 0, y: 5 };
    d.finish(); await work; expect(h.service.snapshot().position.moves.at(-1)?.to).toEqual(black.to); h.service.dispose();
  });
  test('worker error is explicitly recorded as unknown, not silently scored safe', async () => {
    const h = harness({ async search() { throw new Error('worker unavailable'); } });
    await h.port.commit(black, '保留单步审查，不把搜索失败当安全。');
    const review = h.service.record().notes[0].review!;
    expect(review.searchError).toBe('worker unavailable'); expect(review.warnings.join('')).toContain('未知'); h.service.dispose();
  });
  test('actual bottom-cannon combination is caught even if the model skips all analysis tools', async () => {
    let live = false; const driver = new Driver();
    const service = new GameService(driver, model, { now: () => 0, search: { async search(p, options, signal) {
      return live ? searchPosition(p, { ...options, signal }) : unknown(p);
    } } });
    for (const move of PASSIVE_GAME.slice(0, 47)) {
      const s = service.snapshot();
      if (s.position.next === s.human) service.humanMove(move, s.revision);
      else await driver.turns.at(-1)!.commit(move, '合法重放用于组合杀回归。', '测试重现历史走法，明确接受已记录的交换与失子风险。');
    }
    live = true; const port = driver.turns.at(-1)!, before = service.snapshot();
    let risk: MoveRiskError | undefined;
    try { await port.commit(PASSIVE_GAME[47], '只按少丢子原则垫炮。'); } catch (e) { if (e instanceof MoveRiskError) risk = e; else throw e; }
    expect(risk?.review.risk).toBe('loss'); expect(risk?.review.search?.completedDepth).toBeGreaterThanOrEqual(4);
    expect(service.snapshot().position).toEqual(before.position); expect(service.snapshot().notes).toEqual(before.notes);
    // Deliberate acceptance remains possible; the business layer never substitutes a move.
    await port.commit(PASSIVE_GAME[47], '已知败势仍选择抵抗。', '接受多步搜索发现的底炮车肋道杀棋；此处不是宣称存在弃炮补偿。');
    expect(service.record().notes.at(-1)?.review?.risk).toBe('loss'); service.dispose();
  }, 10000);
});

describe('plans persist atomically with successful moves', () => {
  test('draft/failed move do not persist; success saves plan and next opponent turn requires recheck', async () => {
    const h = harness(); h.port.updatePlan!(draft);
    expect(h.service.snapshot().plan).toBeNull(); expect(h.service.record().notes).toHaveLength(0);
    await expect(h.port.commit(red, '非法走法不能保存计划。')).rejects.toThrow(); expect(h.service.snapshot().plan).toBeNull();
    await h.port.commit(black, '按计划先处理当前局面。');
    expect(h.service.record().plan?.status).toBe('active'); expect(h.service.record().notes[0].planUpdate?.action).toBe('revise');
    h.service.humanMove({ from: { x: 2, y: 6 }, to: { x: 2, y: 5 } }, h.service.snapshot().revision);
    const next = h.driver.turns.at(-1)!;
    expect(next.state.plan?.status).toBe('needs-review');
    next.updatePlan!({ action: 'continue', reason: '对方挺兵后重新检查，目标仍然有效。' });
    await next.commit({ from: { x: 2, y: 3 }, to: { x: 2, y: 4 } }, '继续协调兵力。');
    expect(h.service.record().notes.at(-1)?.plan?.reviewedPly).toBe(3);
    h.service.undo(); expect(h.service.snapshot().plan).toBeNull();
    h.service.newGame(1); expect(h.service.snapshot().plan).toBeNull(); h.service.dispose();
  });
  test('model switch and new round clear the old plan', async () => {
    const h = harness(); h.port.updatePlan!(draft); await h.port.commit(black, '先协调子力。');
    h.service.setModel(model); expect(h.service.snapshot().plan).toBeNull();
    h.service.resign(); h.service.nextRound(); expect(h.service.snapshot().plan).toBeNull(); h.service.dispose();
  });
});
