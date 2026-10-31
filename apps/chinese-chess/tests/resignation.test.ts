import { describe, expect, test } from 'bun:test';
import { GameService, type AgentDriver, type TurnPort } from '../src/business/game-service';
import { normalizeRecord } from '../src/business/learning';
import { DEFAULT_SETTINGS } from '../src/business/clock';
import { createDecisionTrace } from '../src/business/decision';
import { searchPosition } from '../src/business/search';
import type { SearchDriver } from '../src/business/search';

const model = { provider: 'test', id: 'resign', name: 'Resignation fixture' };
const red = { from: { x: 0, y: 6 }, to: { x: 0, y: 5 } };
const black = { from: { x: 0, y: 3 }, to: { x: 0, y: 4 } };
class Driver implements AgentDriver {
  turns: TurnPort[] = [];
  async run(port: TurnPort) { this.turns.push(port); await new Promise<void>(() => {}); }
}
function harness(search?: SearchDriver) {
  let now = 0; const driver = new Driver();
  const service = new GameService(driver, model, { now: () => now, settings: { ...DEFAULT_SETTINGS, timeControl: 'fischer', incrementMs: 3000 },
    search: search ?? { async search(p) { return searchPosition(p, { maxMs: 0, maxNodes: 0 }); } } });
  service.humanMove(red, 0);
  return { service, port: driver.turns[0], advance(ms: number) { now += ms; } };
}

describe('machine resignation is an authoritative terminal action, not a fake move', () => {
  test('ends atomically, persists public reason/audit/timing, awards human once, grants no increment', async () => {
    const h = harness(), before = h.service.snapshot(), saved: ReturnType<GameService['record']>[] = [];
    h.service.subscribe(state => { if (state.outcome) saved.push(h.service.record()); });
    h.port.setDecision!(createDecisionTrace(before.revision, { playbook: 'playbook-endgame', evidence: 'fixture' }));
    h.port.telemetry!({ type: 'start', id: 'resign', kind: 'tool', name: 'resign_game' });
    h.advance(1250); await h.port.resign!('无已验证解围手段，主动认输。');
    const after = h.service.snapshot(), record = saved[0];
    expect(after.status).toBe('over'); expect(after.outcome).toMatchObject({ winner: 1, reason: 'resign' });
    expect(after.match.humanWins).toBe(1); expect(after.clock.running).toBeNull(); expect(h.port.signal.aborted).toBe(true);
    expect(after.position).toEqual(before.position); expect(after.notes).toEqual(before.notes); expect(after.evaluations).toEqual(before.evaluations);
    expect(after.clock.players[2].mainMs).toBe(before.clock.players[2].mainMs - 1250);
    expect(record.resignation).toMatchObject({ color: 2, afterPly: 1, reason: '无已验证解围手段，主动认输。', model: 'test/resign' });
    expect(normalizeRecord(record).outcome).toEqual({ winner: 1, reason: 'resign' });
    expect(() => normalizeRecord({ ...record, resignation: { ...record.resignation, color: 1 } })).toThrow('认输结果不一致');
    expect(() => normalizeRecord({ ...record, resignation: { ...record.resignation, afterPly: 0 } })).toThrow('认输记录');
    expect(() => normalizeRecord({ ...record, resignation: undefined })).toThrow('认输结果不一致');
    expect(record.resignation?.decision?.tools.at(-1)).toEqual({ name: 'resign_game', ok: true });
    expect(record.resignation?.decision?.steps.find(s => s.id === 'commit')?.status).toBe('done');
    expect(record.resignation?.timing?.spans.at(-1)?.status).toBe('ok'); expect(record.resignation?.timing?.totalMs).toBe(1250);
    await expect(h.port.resign!('重复认输不可重复结算。')).rejects.toThrow();
    await expect(h.port.commit(black, '认输后迟到落子。')).rejects.toThrow();
    h.advance(100000); h.service.tick(); expect(h.service.snapshot().clock).toEqual(after.clock);
    expect(h.service.snapshot().match.humanWins).toBe(1);
    h.service.nextRound(); expect(h.service.record().resignation).toBeUndefined(); h.service.dispose();
  });
  test('charge deadline before resignation; late calls cannot turn timeout into resign', async () => {
    const h = harness(); h.advance(DEFAULT_SETTINGS.mainTimeMs);
    await expect(h.port.resign!('迟到认输。')).rejects.toThrow();
    expect(h.service.snapshot().outcome?.reason).toBe('main-time'); expect(h.service.record().resignation).toBeUndefined(); h.service.dispose();
  });
  test('cancelled tools, invalid reasons and stale ports cannot resign', async () => {
    const h = harness(), operation = new AbortController(); operation.abort();
    await expect(h.port.resign!('已取消的请求。', operation.signal)).rejects.toThrow();
    for (const reason of ['', '   ', 'x'.repeat(601)]) await expect(h.port.resign!(reason)).rejects.toThrow();
    expect(h.service.snapshot().outcome).toBeNull();
    h.service.cancel(); await expect(h.port.resign!('旧回合不能认输。')).rejects.toThrow();
    h.service.newGame(2); expect(h.service.snapshot().outcome).toBeNull(); h.service.dispose();
  });
  test('cannot resign during async commit/search or after an accepted move', async () => {
    let resolve!: () => void;
    const h = harness({ search(p) { return new Promise(r => { resolve = () => r(searchPosition(p, { maxMs: 0, maxNodes: 0 })); }); } });
    const work = h.port.commit(black, '先提交落子。');
    await expect(h.port.resign!('并发认输不应生效。')).rejects.toThrow('并发'); resolve(); await work;
    await expect(h.port.resign!('落子后不是机器回合。')).rejects.toThrow();
    expect(h.service.snapshot().outcome).toBeNull(); expect(h.service.snapshot().position.moves).toHaveLength(2); h.service.dispose();
  });
  test('human resignation uses the same record field but awards machine', () => {
    const h = harness(); h.service.resign();
    expect(h.service.snapshot().outcome).toMatchObject({ winner: 2, reason: 'resign' });
    expect(h.service.record().resignation).toMatchObject({ color: 1, afterPly: 1 }); h.service.dispose();
  });
});
