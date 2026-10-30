import { describe, expect, test } from 'bun:test';
import { chargeClock, DEFAULT_SETTINGS, newClock, switchClock, validateSettings } from '../src/business/clock';
import { GameService, type AgentDriver, type TurnPort } from '../src/business/game-service';
import { MoveRiskError } from '../src/business/expert';
import { RECORDED_GAME } from './fixtures/recorded-game';
import type { MatchSettings } from '../src/shared/types';
const model = { provider: 'test', id: 'controlled', name: 'Controlled' };
const red = { from: { x: 0, y: 6 }, to: { x: 0, y: 5 } };
const black = { from: { x: 0, y: 3 }, to: { x: 0, y: 4 } };
class Driver implements AgentDriver { turns: TurnPort[] = []; async run(port: TurnPort) { this.turns.push(port); await new Promise<void>(() => {}); } }
function harness(overrides: Partial<MatchSettings> = {}) {
  let now = 0; const driver = new Driver();
  const service = new GameService(driver, model, { now: () => now, settings: { ...DEFAULT_SETTINGS, mainTimeMs: 1000, incrementMs: 100, ...overrides } });
  return { driver, service, advance(ms: number) { now += ms; } };
}
describe('authoritative Fischer / absolute clocks', () => {
  test('only active side charged, increment awarded once after a timely move', () => {
    const s = { ...DEFAULT_SETTINGS, mainTimeMs: 1000, incrementMs: 100 }, c = newClock(s, 0);
    chargeClock(c, s, 300); expect(c.players[1].mainMs).toBe(700); expect(c.players[2].mainMs).toBe(1000);
    switchClock(c, s, 2); expect(c.players[1].mainMs).toBe(800);
    chargeClock(c, s, 500); expect(c.players[2].mainMs).toBe(800);
    chargeClock(c, s, 400); expect(c.players[2].mainMs).toBe(800);
    expect(chargeClock(c, s, 1300).timeout).toBe('main-time');
    const a = { ...s, timeControl: 'absolute' as const }, d = newClock(a, 0);
    chargeClock(d, a, 300); switchClock(d, a, 2); expect(d.players[1].mainMs).toBe(700);
    d.running = null; chargeClock(d, a, 99999); expect(d.players[2].mainMs).toBe(1000);
  });
  test('settings validation', () => {
    for (const change of [{ bestOf: 2 }, { timeControl: 'byoyomi' }, { mainTimeMs: 0 }, { mainTimeMs: NaN }, { incrementMs: -1 }, { incrementMs: 60001 }, { allowUndo: 'true' }]) expect(() => validateSettings({ ...DEFAULT_SETTINGS, ...change })).toThrow();
  });
  test('deadline equality beats late human and LLM moves, even without heartbeat', () => {
    const h = harness(); h.advance(1000); expect(() => h.service.humanMove(red, 0)).toThrow();
    expect(h.service.snapshot().outcome).toMatchObject({ winner: 2, reason: 'main-time' }); h.service.tick();
    expect(h.service.snapshot().match.rounds).toHaveLength(1); h.service.dispose();
    const p = harness(); p.service.humanMove(red, 0); const port = p.driver.turns[0]; p.advance(1000);
    expect(() => port.commit(black, '迟到')).toThrow(); expect(port.signal.aborted).toBe(true);
    expect(p.service.snapshot().outcome?.winner).toBe(1); expect(p.service.snapshot().position.moves).toHaveLength(1); p.service.dispose();
  });
  test('cancel, retry, change model, undo do not refund or pause time', () => {
    const h = harness({ allowUndo: true }); h.advance(200); h.service.humanMove(red, 0);
    expect(h.service.snapshot().clock.players[1].mainMs).toBe(900);
    h.advance(300); h.service.cancel(); expect(h.service.snapshot().clock.players[2].mainMs).toBe(700);
    h.advance(100); h.service.retry(); expect(h.service.snapshot().clock.players[2].mainMs).toBe(600);
    h.advance(100); h.service.setModel(model); expect(h.service.snapshot().clock.players[2].mainMs).toBe(500);
    h.service.undo(); const s = h.service.snapshot(); expect(s.position.moves).toHaveLength(0); expect(s.clock.running).toBe(1); expect(s.clock.players[1].mainMs).toBe(900); h.service.dispose();
  });
});
function recordedTurn(plies: number) {
  const h = harness({ mainTimeMs: 600000 });
  for (const move of RECORDED_GAME.slice(0, plies)) {
    const s = h.service.snapshot();
    if (s.position.next === s.human) h.service.humanMove(move, s.revision);
    else h.driver.turns.at(-1)!.commit(move, '重现历史棋谱用于测试', '回归测试重现旧棋谱，明确接受其中已经记录的子力损失。');
  }
  return h;
}
describe('authoritative business expert guard', () => {
  test('actual free-rook and poisoned-pawn proposals are reviewed even without using a review tool', () => {
    for (const ply of [41, 43]) {
      const h = recordedTurn(ply), before = h.service.snapshot(), port = h.driver.turns.at(-1)!;
      expect(() => port.commit(RECORDED_GAME[ply], '争取主动')).toThrow(MoveRiskError);
      const after = h.service.snapshot(); expect(after.position).toEqual(before.position);
      expect(after.revision).toBe(before.revision); expect(after.notes).toEqual(before.notes);
      expect(after.clock.running).toBe(2); expect(after.status).toBe('thinking');
      expect(after.logs.at(-1)?.text).toContain('专家审查要求重新考虑');
      port.commit({ from: { x: 3, y: 6 }, to: { x: 2, y: 6 } }, '横炮避开车的直接攻击，优先保住大子。');
      expect(h.service.snapshot().notes.at(-1)?.review?.risk).toBe('exchange-risk'); h.service.dispose();
    }
  });
  test('explicit, recorded acknowledgement permits deliberate sacrifice without silent substitution', () => {
    const h = recordedTurn(41), port = h.driver.turns.at(-1)!;
    expect(() => port.commit(RECORDED_GAME[41], '主动', '太短')).toThrow('12–400');
    const ack = '测试明确接受车被吃的风险；保留模型最终选择，不由业务层自动换棋。';
    port.commit(RECORDED_GAME[41], '明确接受损失以验证弃子通道', ack);
    const note = h.service.record().notes.at(-1)!;
    expect(note.riskAcknowledgement).toBe(ack); expect(note.review?.estimatedNet).toBe(-900);
    expect(h.service.snapshot().position.moves.at(-1)?.to).toEqual({ x: 1, y: 2 }); h.service.dispose();
  });
  test('expiry during expert computation is checked again before committing', () => {
    let armed = false, reads = 0;
    const driver = new Driver(), service = new GameService(driver, model, {
      now: () => armed ? (++reads === 1 ? 0 : 1001) : 0,
      settings: { ...DEFAULT_SETTINGS, mainTimeMs: 1000, incrementMs: 0 },
    });
    service.humanMove(red, 0); armed = true;
    expect(() => driver.turns[0].commit(black, '及时提交但复查期间到时')).toThrow('审查期间');
    expect(service.snapshot().position.moves).toHaveLength(1);
    expect(service.snapshot().notes).toHaveLength(0);
    expect(service.snapshot().outcome).toMatchObject({ winner: 1, reason: 'main-time' }); service.dispose();
  });
  test('review does not revive an expired turn or bypass the clock', () => {
    const h = recordedTurn(41), port = h.driver.turns.at(-1)!;
    h.advance(700000);
    expect(() => port.commit(RECORDED_GAME[41], '迟到', '明确接受损失，仍不能绕过已经耗尽的比赛棋钟。')).toThrow();
    expect(h.service.snapshot().outcome?.reason).toBe('main-time'); h.service.dispose();
  });
});
describe('turn validity and matches', () => {
  test('real legal commit, reason recording, stale/double/illegal tool calls', () => {
    const h = harness(); h.service.humanMove(red, 0); const port = h.driver.turns[0];
    expect(() => port.commit(red, '走错颜色')).toThrow(); expect(() => port.commit(black, '')).toThrow();
    h.advance(100); port.commit(black, '挺卒争夺河界。');
    expect(h.service.snapshot().position.moves).toHaveLength(2); expect(h.service.snapshot().notes[0].reason).toBe('挺卒争夺河界。');
    expect(h.service.snapshot().clock.players[2].mainMs).toBe(1000); expect(() => port.commit(black, '重复')).toThrow();
    expect(() => h.service.humanMove(red, 0)).toThrow(); expect(() => h.service.undo()).toThrow('不允许');
    expect(h.service.record().format).toBe('chinese-chess/v1'); h.service.dispose();
  });
  test('new game invalidates delayed tools and uses a distinct revision', () => {
    const h = harness(); h.service.humanMove(red, 0); const old = h.driver.turns[0];
    const fresh = h.service.newGame(1); expect(fresh.revision).toBeGreaterThan(old.state.revision);
    expect(() => old.commit(black, '迟到')).toThrow(); expect(fresh.position.moves).toHaveLength(0); h.service.dispose();
  });
  test('invalid settings do not cancel an in-flight turn', () => {
    const h = harness(); h.service.humanMove(red, 0); const port = h.driver.turns[0];
    expect(() => h.service.newGame(1, { ...DEFAULT_SETTINGS, mainTimeMs: 0 })).toThrow(); expect(port.signal.aborted).toBe(false); h.service.dispose();
  });
  test('best of three: scores owned by players, alternate red/black, first to two', () => {
    const h = harness(), before = h.service.snapshot(); h.service.resign(); const s = h.service.nextRound();
    expect(s.match.id).toBe(before.match.id); expect(s.id).not.toBe(before.id); expect(s.human).toBe(2);
    expect(s.clock.players[1].mainMs).toBe(1000); expect(s.match.machineWins).toBe(1); expect(s.match.winner).toBeNull();
    h.service.resign(); expect(h.service.snapshot().match.winner).toBe('machine'); expect(h.service.snapshot().match.machineWins).toBe(2);
    expect(() => h.service.nextRound()).toThrow('比赛已经结束'); expect(() => h.service.undo()).toThrow('已结算'); h.service.dispose();
  });
  test('best of five may span five rounds; new match resets everything', () => {
    const h = harness({ bestOf: 5, timeControl: 'absolute' });
    for (const winner of ['human', 'machine', 'machine', 'human', 'human']) {
      const s = h.service.snapshot(); const loser = winner === 'human' ? (s.human === 1 ? 2 : 1) : s.human;
      if (s.position.next !== loser) { if (s.human === 1) h.service.humanMove(red, s.revision); else h.driver.turns.at(-1)!.commit(red, '开局'); }
      h.advance(1000); h.service.tick();
      if (h.service.snapshot().match.rounds.length < 5) h.service.nextRound();
    }
    const s = h.service.snapshot(); expect(s.match.humanWins).toBe(3); expect(s.match.machineWins).toBe(2); expect(s.match.winner).toBe('human');
    expect(h.service.newGame(1).match.rounds).toHaveLength(0); h.service.dispose();
  });
  test('repetition settles as draw with same colors on replay', () => {
    const h = harness(); const sequence = [
      { from: { x: 1, y: 9 }, to: { x: 2, y: 7 } }, { from: { x: 1, y: 0 }, to: { x: 2, y: 2 } },
      { from: { x: 2, y: 7 }, to: { x: 1, y: 9 } }, { from: { x: 2, y: 2 }, to: { x: 1, y: 0 } },
    ];
    for (const m of [...sequence, ...sequence]) {
      const s = h.service.snapshot(); if (s.position.next === s.human) h.service.humanMove(m, s.revision); else h.driver.turns.at(-1)!.commit(m, '重复局面');
    }
    expect(h.service.snapshot().outcome?.winner).toBe('draw'); expect(h.service.snapshot().match.draws).toBe(1); expect(h.service.nextRound().human).toBe(1); h.service.dispose();
  });
  test('missing model, missing tool call and network errors never silently substitute a local AI', async () => {
    const none = new GameService({ async run() {} }); none.humanMove(red, 0); expect(none.snapshot().status).toBe('error'); none.dispose();
    for (const driver of [{ async run() {} }, { async run() { throw new Error('network error'); } }]) {
      const s = new GameService(driver, model); s.humanMove(red, 0); await Bun.sleep(5); expect(s.snapshot().status).toBe('error'); expect(s.snapshot().position.moves).toHaveLength(1); s.dispose();
    }
  });
});
describe('pushed views stay small as the game grows', () => {
  test('subscribers and replies omit per-ply evaluations; evaluation(id, ply) returns one', () => {
    const h = harness(), pushed: number[] = [];
    h.service.subscribe(s => pushed.push(s.evaluations.length));
    const reply = h.service.humanMove(red, h.service.snapshot().revision);
    expect(reply.evaluations).toHaveLength(0);
    expect(h.service.snapshot().evaluations).toHaveLength(1);
    h.service.tick();
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed.every(n => n === 0)).toBe(true);
    const id = h.service.snapshot().id;
    expect(h.service.evaluation(id, 1)).toEqual(h.service.snapshot().evaluations[0]);
    expect(h.service.evaluation(id, 2)).toBeNull();
    expect(h.service.evaluation('another-game', 1)).toBeNull();
    expect(h.service.evaluation(id, 0)).toBeNull();
    h.service.dispose();
  });
});
