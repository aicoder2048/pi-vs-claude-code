import { describe, expect, test } from 'bun:test';
import { chargeClock, DEFAULT_SETTINGS, newClock, switchClock, validateSettings } from '../src/business/clock';
import { GameService, type AgentDriver, type TurnPort } from '../src/business/game-service';
import { MoveRiskError } from '../src/business/expert';
import { createDecisionTrace, recordDecisionTool, turnGuidance } from '../src/business/decision';
import { normalizeRecord } from '../src/business/learning';
import { searchPosition } from '../src/business/search';
import { recordSaveKey } from '../src/business/turn-timing';
const noSearch = { async search(p: import('../src/business/engine').Position) { return searchPosition(p, { maxMs: 0, maxNodes: 0 }); } };
import { RECORDED_GAME } from './fixtures/recorded-game';
import type { MatchSettings } from '../src/shared/types';
const model = { provider: 'test', id: 'controlled', name: 'Controlled' };
const red = { from: { x: 0, y: 6 }, to: { x: 0, y: 5 } };
const black = { from: { x: 0, y: 3 }, to: { x: 0, y: 4 } };
class Driver implements AgentDriver { turns: TurnPort[] = []; async run(port: TurnPort) { this.turns.push(port); await new Promise<void>(() => {}); } }
function harness(overrides: Partial<MatchSettings> = {}) {
  let now = 0; const driver = new Driver();
  const service = new GameService(driver, model, { now: () => now, search: noSearch, settings: { ...DEFAULT_SETTINGS, timeControl: 'fischer', mainTimeMs: 1000, incrementMs: 100, ...overrides } });
  return { driver, service, advance(ms: number) { now += ms; } };
}
describe('authoritative Fischer / absolute clocks', () => {
  test('new matches default to 30 minutes per side, absolute time with no increment', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ timeControl: 'absolute', mainTimeMs: 1800000, incrementMs: 0 });
    const service = new GameService(new Driver(), model, { now: () => 0, search: noSearch });
    expect(service.snapshot().clock.players).toEqual({ 1: { mainMs: 1800000 }, 2: { mainMs: 1800000 } });
    expect(service.record().match.settings).toEqual(DEFAULT_SETTINGS); service.dispose();
  });
  test('both sides may think for many minutes; only their remaining clock limits a move', async () => {
    const h = harness({ ...DEFAULT_SETTINGS });
    h.advance(12 * 60000); h.service.humanMove(red, 0);
    expect(h.service.snapshot().clock.players[1].mainMs).toBe(18 * 60000);
    const port = h.driver.turns[0];
    h.advance(20 * 60000); h.service.tick();
    expect(port.signal.aborted).toBe(false); expect(h.service.snapshot().status).toBe('thinking');
    await port.commit(black, '长考二十分钟后及时落子，仍只扣己方总棋钟。');
    expect(h.service.snapshot().clock.players[2].mainMs).toBe(10 * 60000);
    expect(h.service.snapshot().notes[0].elapsedMs).toBe(20 * 60000);
    expect(h.service.snapshot().outcome).toBeNull();
    h.service.resign(); h.service.nextRound();
    expect(h.service.snapshot().clock.players).toEqual({ 1: { mainMs: 1800000 }, 2: { mainMs: 1800000 } }); h.service.dispose();
  });
  test('only active side charged, increment awarded once after a timely move', () => {
    const s = { ...DEFAULT_SETTINGS, timeControl: 'fischer' as const, mainTimeMs: 1000, incrementMs: 100 }, c = newClock(s, 0);
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
  test('deadline equality beats late human and LLM moves, even without heartbeat', async () => {
    const h = harness(); h.advance(1000); expect(() => h.service.humanMove(red, 0)).toThrow();
    expect(h.service.snapshot().outcome).toMatchObject({ winner: 2, reason: 'main-time' }); h.service.tick();
    expect(h.service.snapshot().match.rounds).toHaveLength(1); h.service.dispose();
    const p = harness(); p.service.humanMove(red, 0); const port = p.driver.turns[0]; p.advance(1000);
    await expect(port.commit(black, '迟到')).rejects.toThrow(); expect(port.signal.aborted).toBe(true);
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
async function recordedTurn(plies: number) {
  const h = harness({ mainTimeMs: 600000 });
  for (const move of RECORDED_GAME.slice(0, plies)) {
    const s = h.service.snapshot();
    if (s.position.next === s.human) h.service.humanMove(move, s.revision);
    else await h.driver.turns.at(-1)!.commit(move, '重现历史棋谱用于测试', '回归测试重现旧棋谱，明确接受其中已经记录的子力损失。');
  }
  return h;
}
describe('decision persistence', () => {
  test('accepted commit audit is complete at the first emitted/saveable revision, detached from driver state', async () => {
    const h = harness(), saved: ReturnType<GameService['record']>[] = [];
    h.service.subscribe(() => { saved.push(h.service.record()); });
    h.service.humanMove(red, 0); const port = h.driver.turns[0];
    const trace = createDecisionTrace(port.state.revision, turnGuidance(port.state)!);
    recordDecisionTool(trace, 'move_piece', false); recordDecisionTool(trace, 'review_move', true);
    trace.skillsRead.push('compare-candidates'); port.setDecision!(trace);
    await port.commit(black, '先安全挺卒');
    const record = saved.find(r => r.moves.length === 2)!;
    const decision = record.notes[0].decision!;
    expect(decision.tools).toEqual([{ name: 'move_piece', ok: false }, { name: 'review_move', ok: true }, { name: 'move_piece', ok: true }]);
    expect(decision.steps.find(s => s.id === 'commit')?.status).toBe('done');
    trace.skillsRead.push('coordinates');
    expect(h.service.record().notes[0].decision).toEqual(decision);
    expect(normalizeRecord(record).moves).toHaveLength(2);
    delete record.notes[0].decision;
    expect(normalizeRecord(record).moves).toHaveLength(2);
    h.service.dispose();
  });
});
describe('authoritative business expert guard', () => {
  test('actual free-rook and poisoned-pawn proposals are reviewed even without using a review tool', async () => {
    for (const ply of [41, 43]) {
      const h = await recordedTurn(ply), before = h.service.snapshot(), port = h.driver.turns.at(-1)!;
      await expect(port.commit(RECORDED_GAME[ply], '争取主动')).rejects.toThrow(MoveRiskError);
      const after = h.service.snapshot(); expect(after.position).toEqual(before.position);
      expect(after.revision).toBe(before.revision); expect(after.notes).toEqual(before.notes);
      expect(after.clock.running).toBe(2); expect(after.status).toBe('thinking');
      expect(after.logs.at(-1)?.text).toContain('专家审查要求重新考虑');
      await port.commit({ from: { x: 3, y: 6 }, to: { x: 2, y: 6 } }, '横炮避开车的直接攻击，优先保住大子。');
      expect(h.service.snapshot().notes.at(-1)?.review?.risk).toBe('exchange-risk'); h.service.dispose();
    }
  });
  test('explicit, recorded acknowledgement permits deliberate sacrifice without silent substitution', async () => {
    const h = await recordedTurn(41), port = h.driver.turns.at(-1)!;
    await expect(port.commit(RECORDED_GAME[41], '主动', '太短')).rejects.toThrow('12–400');
    const ack = '测试明确接受车被吃的风险；保留模型最终选择，不由业务层自动换棋。';
    await port.commit(RECORDED_GAME[41], '明确接受损失以验证弃子通道', ack);
    const note = h.service.record().notes.at(-1)!;
    expect(note.riskAcknowledgement).toBe(ack); expect(note.review?.estimatedNet).toBe(-900);
    expect(h.service.snapshot().position.moves.at(-1)?.to).toEqual({ x: 1, y: 2 }); h.service.dispose();
  });
  test('expiry during expert computation is checked again before committing', async () => {
    let armed = false, reads = 0;
    const driver = new Driver(), service = new GameService(driver, model, {
      now: () => armed ? (++reads === 1 ? 0 : 1001) : 0,
      settings: { ...DEFAULT_SETTINGS, mainTimeMs: 1000, incrementMs: 0 },
    });
    service.humanMove(red, 0); armed = true;
    await expect(driver.turns[0].commit(black, '及时提交但复查期间到时')).rejects.toThrow('审查期间');
    expect(service.snapshot().position.moves).toHaveLength(1);
    expect(service.snapshot().notes).toHaveLength(0);
    expect(service.snapshot().outcome).toMatchObject({ winner: 1, reason: 'main-time' }); service.dispose();
  });
  test('review does not revive an expired turn or bypass the clock', async () => {
    const h = await recordedTurn(41), port = h.driver.turns.at(-1)!;
    h.advance(700000);
    await expect(port.commit(RECORDED_GAME[41], '迟到', '明确接受损失，仍不能绕过已经耗尽的比赛棋钟。')).rejects.toThrow();
    expect(h.service.snapshot().outcome?.reason).toBe('main-time'); h.service.dispose();
  });
});
describe('turn validity and matches', () => {
  test('real legal commit, reason recording, stale/double/illegal tool calls', async () => {
    const h = harness(); h.service.humanMove(red, 0); const port = h.driver.turns[0];
    await expect(port.commit(red, '走错颜色')).rejects.toThrow(); await expect(port.commit(black, '')).rejects.toThrow();
    h.advance(100); await port.commit(black, '挺卒争夺河界。');
    expect(h.service.snapshot().position.moves).toHaveLength(2); expect(h.service.snapshot().notes[0].reason).toBe('挺卒争夺河界。');
    expect(h.service.snapshot().clock.players[2].mainMs).toBe(1000); await expect(port.commit(black, '重复')).rejects.toThrow();
    expect(() => h.service.humanMove(red, 0)).toThrow(); expect(() => h.service.undo()).toThrow('不允许');
    expect(h.service.record().format).toBe('chinese-chess/v1'); h.service.dispose();
  });
  test('new game invalidates delayed tools and uses a distinct revision', async () => {
    const h = harness(); h.service.humanMove(red, 0); const old = h.driver.turns[0];
    const fresh = h.service.newGame(1); expect(fresh.revision).toBeGreaterThan(old.state.revision);
    await expect(old.commit(black, '迟到')).rejects.toThrow(); expect(fresh.position.moves).toHaveLength(0); h.service.dispose();
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
  test('best of five may span five rounds; new match resets everything', async () => {
    const h = harness({ bestOf: 5, timeControl: 'absolute' });
    for (const winner of ['human', 'machine', 'machine', 'human', 'human']) {
      const s = h.service.snapshot(); const loser = winner === 'human' ? (s.human === 1 ? 2 : 1) : s.human;
      if (s.position.next !== loser) { if (s.human === 1) h.service.humanMove(red, s.revision); else await h.driver.turns.at(-1)!.commit(red, '开局'); }
      h.advance(1000); h.service.tick();
      if (h.service.snapshot().match.rounds.length < 5) h.service.nextRound();
    }
    const s = h.service.snapshot(); expect(s.match.humanWins).toBe(3); expect(s.match.machineWins).toBe(2); expect(s.match.winner).toBe('human');
    expect(h.service.newGame(1).match.rounds).toHaveLength(0); h.service.dispose();
  });
  test('repetition settles as draw with same colors on replay', async () => {
    const h = harness(); const sequence = [
      { from: { x: 1, y: 9 }, to: { x: 2, y: 7 } }, { from: { x: 1, y: 0 }, to: { x: 2, y: 2 } },
      { from: { x: 2, y: 7 }, to: { x: 1, y: 9 } }, { from: { x: 2, y: 2 }, to: { x: 1, y: 0 } },
    ];
    for (const m of [...sequence, ...sequence]) {
      const s = h.service.snapshot(); if (s.position.next === s.human) h.service.humanMove(m, s.revision); else await h.driver.turns.at(-1)!.commit(m, '重复局面');
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
describe('failed-turn recovery and durable diagnostics', () => {
  test('failure saves its cause/audit, revokes late tools, and retry remains usable without a clock refund', async () => {
    let now = 0;
    const turns: TurnPort[] = [], saves: ReturnType<GameService['record']>[] = [];
    const service = new GameService({ async run(port) {
      turns.push(port);
      if (turns.length > 1) return new Promise<void>(() => {});
      const trace = createDecisionTrace(port.state.revision, turnGuidance(port.state)!);
      recordDecisionTool(trace, 'update_plan', true); port.setDecision!(trace);
      port.log('agent', 'LLM 请求 8/8');
      now = 23475; throw new Error('已达到单回合 8 次 LLM 请求上限');
    } }, model, { now: () => now, search: noSearch });
    let savedKey = '';
    service.subscribe(state => {
      const key = recordSaveKey(state);
      if (key !== savedKey) { savedKey = key; saves.push(service.record()); }
    });
    try {
      service.humanMove(red, 0); await Bun.sleep(5);
      const failure = service.snapshot();
      expect(failure.status).toBe('error'); expect(failure.outcome).toBeNull();
      expect(turns[0].signal.aborted).toBe(true);
      const saved = saves.at(-1)!;
      expect(saved.attempts?.at(-1)?.error).toContain('8 次');
      expect(saved.attempts?.at(-1)?.decision?.tools).toEqual([{ name: 'update_plan', ok: true }]);
      expect(saved.logs?.at(-1)?.text).toContain('本回合未落子');
      expect(saved.attempts?.at(-1)?.timing.totalMs).toBe(23475);
      await expect(turns[0].commit(black, '失败回合不能迟到提交')).rejects.toThrow();
      now += 1000;
      expect(service.retry().status).toBe('thinking');
      expect(service.snapshot().clock.players[2].mainMs).toBe(DEFAULT_SETTINGS.mainTimeMs - now);
      expect(turns[1].signal.aborted).toBe(false);
      turns[0].log('agent', '旧请求不应污染重试日志');
      expect(service.record().logs?.some(l => l.text.includes('污染'))).toBe(false);
      await turns[1].commit(black, '重试后合法落子。');
      expect(service.snapshot().status).toBe('human');
      expect(service.record().moves).toHaveLength(2);
      expect(service.record().attempts?.at(-1)?.error).toContain('8 次');
    } finally { service.dispose(); }
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
