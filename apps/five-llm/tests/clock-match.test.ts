import { describe, expect, test } from 'bun:test';
import { chargeClock, DEFAULT_SETTINGS, newClock, switchClock, validateSettings } from '../src/business/clock';
import { GameService, type AgentDriver, type TurnPort } from '../src/business/game-service';
import type { Color, Point } from '../src/business/engine';
import type { MatchSettings } from '../src/shared/types';
const model = { provider: 'test', id: 'controlled', name: 'Controlled' };
class Driver implements AgentDriver {
  turns: TurnPort[] = [];
  async run(port: TurnPort) { this.turns.push(port); await new Promise<void>(() => {}); }
}
const settings: MatchSettings = { ...DEFAULT_SETTINGS, mainTimeMs: 1000, periodTimeMs: 100, periods: 3 };
function harness(overrides: Partial<MatchSettings> = {}) {
  let now = 0;
  const driver = new Driver(), service = new GameService(driver, model, { now: () => now, settings: { ...settings, ...overrides } });
  return { service, driver, advance(ms: number) { now += ms; } };
}
function move(service: GameService, driver: Driver, point: Point): void {
  const state = service.snapshot();
  if (state.position.next === state.human) service.humanMove(point, state.revision);
  else driver.turns.at(-1)!.commit(point, '测试落子');
}
describe('pure main-time and Japanese byoyomi clock', () => {
  test('only active player is charged; per-player main time is cumulative', () => {
    const clock = newClock(settings, 0);
    chargeClock(clock, settings, 300); expect(clock.players[1].mainMs).toBe(700); expect(clock.players[2].mainMs).toBe(1000);
    switchClock(clock, settings, 2); chargeClock(clock, settings, 500);
    expect(clock.players[2].mainMs).toBe(800); switchClock(clock, settings, 1);
    chargeClock(clock, settings, 700); expect(clock.players[1].mainMs).toBe(500); expect(clock.turnElapsedMs).toBe(200);
  });
  test('main time exhaustion enters overtime, not immediate loss', () => {
    const clock = newClock(settings, 0);
    expect(chargeClock(clock, settings, 1000).timeout).toBeNull();
    expect(clock.players[1]).toEqual({ mainMs: 0, periodMs: 100, periodsLeft: 3 });
    expect(chargeClock(clock, settings, 1075)).toEqual({ timeout: null, lostPeriods: 0 }); expect(clock.players[1].periodMs).toBe(25);
  });
  test('step overtime consumes one period; timely move restores seconds, not lost periods', () => {
    const clock = newClock(settings, 0);
    expect(chargeClock(clock, settings, 1110)).toEqual({ timeout: null, lostPeriods: 1 });
    expect(clock.players[1]).toEqual({ mainMs: 0, periodMs: 90, periodsLeft: 2 });
    switchClock(clock, settings, 2); expect(clock.players[1]).toEqual({ mainMs: 0, periodMs: 100, periodsLeft: 2 });
  });
  test('large delayed heartbeat accounts for all crossed periods and loses the final one', () => {
    const clock = newClock(settings, 0);
    expect(chargeClock(clock, settings, 1250)).toEqual({ timeout: null, lostPeriods: 2 });
    expect(clock.players[1].periodMs).toBe(50);
    expect(chargeClock(clock, settings, 5000)).toEqual({ timeout: 'byoyomi', lostPeriods: 1 });
    expect(clock.players[1].periodsLeft).toBe(0); expect(clock.players[1].periodMs).toBe(0);
  });
  test('absolute mode loses at the exact main deadline and has no overtime', () => {
    const absolute = { ...settings, timeControl: 'absolute' as const }, clock = newClock(absolute, 0);
    expect(chargeClock(clock, absolute, 999).timeout).toBeNull();
    expect(chargeClock(clock, absolute, 1000).timeout).toBe('main-time');
  });
  test('pure byoyomi (zero main) and clock-stopped states', () => {
    const s = { ...settings, mainTimeMs: 0 }, clock = newClock(s, 0);
    expect(chargeClock(clock, s, 100).lostPeriods).toBe(1);
    clock.running = null; const before = structuredClone(clock.players); chargeClock(clock, s, 9999); expect(clock.players).toEqual(before);
  });
  test('backward wallclock movement never refunds time', () => {
    const clock = newClock(settings, 100);
    chargeClock(clock, settings, 200); chargeClock(clock, settings, 150); chargeClock(clock, settings, 250);
    expect(clock.players[1].mainMs).toBe(850);
  });
  test('settings validation rejects malformed IPC controls', () => {
    for (const invalid of [{ bestOf: 4 }, { mainTimeMs: -1 }, { mainTimeMs: Infinity }, { periodTimeMs: 0 }, { periods: 0 },
      { periods: 1.5 }, { allowUndo: 'yes' }, { timeControl: 'fischer' }, { timeControl: 'absolute', mainTimeMs: 0 }]) {
      expect(() => validateSettings({ ...settings, ...invalid })).toThrow();
    }
    expect(validateSettings(DEFAULT_SETTINGS).bestOf).toBe(3);
  });
});
describe('authoritative timeout adjudication', () => {
  test('main expires into byoyomi, but final period loses only this round exactly once', () => {
    const h = harness(); h.advance(1000); h.service.tick(); expect(h.service.snapshot().outcome).toBeNull();
    h.advance(100); h.service.tick(); expect(h.service.snapshot().clock.players[1].periodsLeft).toBe(2);
    h.advance(200); h.service.tick(); const s = h.service.snapshot();
    expect(s.outcome).toMatchObject({ winner: 2, reason: 'byoyomi' }); expect(s.position.winner).toBeNull();
    expect(s.match.machineWins).toBe(1); expect(s.match.winner).toBeNull(); expect(s.clock.running).toBeNull();
    h.advance(5000); h.service.tick(); expect(h.service.snapshot().match.rounds).toHaveLength(1);
    expect(h.service.record().result).toBe(2); expect(h.service.record().outcome?.reason).toBe('byoyomi'); h.service.dispose();
  });
  test('a late human move cannot bypass timeout before the next heartbeat', () => {
    const h = harness({ timeControl: 'absolute' }); h.advance(1000);
    expect(() => h.service.humanMove({ x: 7, y: 7 }, 0)).toThrow();
    expect(h.service.snapshot().position.moves).toHaveLength(0); expect(h.service.snapshot().outcome?.reason).toBe('main-time'); h.service.dispose();
  });
  test('a late LLM reply loses the round and is aborted even without a heartbeat', () => {
    const h = harness({ timeControl: 'absolute' }); h.service.humanMove({ x: 7, y: 7 }, 0);
    const port = h.driver.turns[0]; h.advance(1000);
    expect(() => port.commit({ x: 8, y: 8 }, '迟到')).toThrow();
    expect(port.signal.aborted).toBe(true); expect(h.service.snapshot().outcome?.winner).toBe(1);
    expect(h.service.snapshot().position.moves).toHaveLength(1); h.service.dispose();
  });
  test('losing a nonfinal period does not invalidate an in-flight LLM turn', () => {
    const h = harness({ mainTimeMs: 0 }); h.service.humanMove({ x: 7, y: 7 }, 0);
    const port = h.driver.turns[0], revision = h.service.snapshot().revision;
    h.advance(110); h.service.tick(); expect(h.service.snapshot().revision).toBe(revision);
    port.commit({ x: 8, y: 8 }, '在第二次读秒内完成');
    const s = h.service.snapshot(); expect(s.outcome).toBeNull(); expect(s.clock.players[2].periodsLeft).toBe(2);
    expect(s.clock.players[2].periodMs).toBe(100); expect(s.clock.running).toBe(1); h.service.dispose();
  });
  test('cancel, retry and model switching do not stop or reset clocks', () => {
    const h = harness({ mainTimeMs: 0, periodTimeMs: 1000 }); h.service.humanMove({ x: 7, y: 7 }, 0);
    h.advance(400); h.service.cancel(); expect(h.service.snapshot().clock.players[2].periodMs).toBe(600);
    h.advance(100); h.service.retry(); expect(h.service.snapshot().clock.players[2].periodMs).toBe(500);
    h.advance(200); h.service.setModel(model); expect(h.service.snapshot().clock.players[2].periodMs).toBe(300);
    h.advance(301); h.service.tick(); expect(h.service.snapshot().clock.players[2].periodsLeft).toBe(2); h.service.dispose();
  });
  test('default competitive undo disabled; practice undo never refunds time', () => {
    const h = harness(); h.service.humanMove({ x: 7, y: 7 }, 0); expect(() => h.service.undo()).toThrow('不允许'); h.service.dispose();
    const p = harness({ allowUndo: true }); p.advance(200); p.service.humanMove({ x: 7, y: 7 }, 0);
    p.advance(300); p.service.undo(); const s = p.service.snapshot();
    expect(s.clock.players[1].mainMs).toBe(800); expect(s.clock.players[2].mainMs).toBe(700);
    expect(s.position.moves).toHaveLength(0); expect(s.clock.running).toBe(1); p.service.dispose();
  });
});
describe('best-of match state machine', () => {
  test('default best-of-three stops at two wins, alternates colors, resets round clocks', () => {
    const h = harness(); const matchId = h.service.snapshot().match.id, firstId = h.service.snapshot().id;
    h.service.resign(); let s = h.service.nextRound();
    expect(s.match.machineWins).toBe(1); expect(s.match.winner).toBeNull(); expect(s.human).toBe(2);
    expect(s.id).not.toBe(firstId); expect(s.match.id).toBe(matchId); expect(s.clock.players[1].mainMs).toBe(1000);
    h.service.resign(); s = h.service.snapshot(); expect(s.match.machineWins).toBe(2); expect(s.match.winner).toBe('machine');
    expect(() => h.service.nextRound()).toThrow('比赛已经结束'); expect(() => h.service.undo()).toThrow('已结算');
    expect(() => h.service.resign()).toThrow('已结束'); expect(s.match.rounds).toHaveLength(2); h.service.dispose();
  });
  test('best-of-five can go all five rounds; player identity, not color, owns the score', () => {
    const h = harness({ bestOf: 5, timeControl: 'absolute' });
    const winners = ['human', 'machine', 'machine', 'human', 'human'] as const;
    for (let i = 0; i < winners.length; i++) {
      const s = h.service.snapshot(), loser: Color = winners[i] === 'human' ? (s.human === 1 ? 2 : 1) : s.human;
      if (s.position.next !== loser) move(h.service, h.driver, { x: 7, y: 7 });
      h.advance(1000); h.service.tick();
      if (i < winners.length - 1) { expect(h.service.snapshot().match.winner).toBeNull(); h.service.nextRound(); }
    }
    const s = h.service.snapshot(); expect(s.match.humanWins).toBe(3); expect(s.match.machineWins).toBe(2);
    expect(s.match.winner).toBe('human'); expect(s.match.rounds.map(r => r.humanColor)).toEqual([1, 2, 1, 2, 1]); h.service.dispose();
  });
  test('board win is settled and scored by the same match path', () => {
    const h = harness();
    for (let x = 0; x < 5; x++) {
      move(h.service, h.driver, { x, y: 7 });
      if (x < 4) move(h.service, h.driver, { x: x * 2, y: 0 });
    }
    const s = h.service.snapshot(); expect(s.outcome).toMatchObject({ reason: 'five', winner: 1 });
    expect(s.match.humanWins).toBe(1); expect(s.clock.running).toBeNull(); h.service.dispose();
  });
  test('full-board draw scores no win; replay keeps colors and resets time', () => {
    const h = harness(), black: Point[] = [], white: Point[] = [];
    for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) ((x + Math.floor(y / 2)) % 2 === 0 ? black : white).push({ x, y });
    for (let i = 0; i < black.length; i++) {
      move(h.service, h.driver, black[i]); if (white[i]) move(h.service, h.driver, white[i]);
    }
    const s = h.service.snapshot(); expect(s.outcome?.reason).toBe('draw'); expect(s.match.draws).toBe(1);
    expect(s.match.humanWins + s.match.machineWins).toBe(0); expect(s.match.winner).toBeNull();
    expect(h.service.nextRound().human).toBe(1); expect(h.service.snapshot().match.rounds).toHaveLength(1); h.service.dispose();
  });
  test('new match resets scores/settings; invalid settings do not abort the old turn', () => {
    const h = harness(); h.service.resign(); const before = h.service.snapshot();
    const next = h.service.newGame(2, { ...settings, bestOf: 5 });
    expect(next.match.id).not.toBe(before.match.id); expect(next.match.rounds).toEqual([]);
    expect(next.match.humanWins + next.match.machineWins).toBe(0); expect(next.match.settings.bestOf).toBe(5);
    expect(() => h.service.nextRound()).toThrow('尚未结束');
    const active = h.driver.turns.at(-1)!;
    expect(() => h.service.newGame(1, { ...settings, periods: 0 })).toThrow(); expect(active.signal.aborted).toBe(false); h.service.dispose();
  });
});
