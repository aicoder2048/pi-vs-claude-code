import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS } from '../src/business/clock';
import { positionSignals, turnGuidance, validateCandidate } from '../src/business/decision';
import { GameService } from '../src/business/game-service';
import { SIZE, analyze, emptyPosition, other, play, replay, type Move, type Point, type Position } from '../src/business/engine';
import type { GameState } from '../src/shared/types';

function sequence(black: Point[], white: Point[]): Position {
  const moves: Move[] = [];
  black.forEach((p, i) => { moves.push({ ...p, color: 1 }); if (white[i]) moves.push({ ...white[i], color: 2 }); });
  return replay(moves);
}
const row = (xs: number[], y: number) => xs.map(x => ({ x, y }));
function stateAt(position = emptyPosition()): GameState {
  const service = new GameService({ async run() {} }, null, { now: () => 1000 });
  const state = service.snapshot(); service.dispose();
  state.position = position; state.analysis = analyze(position); state.clock.running = position.next;
  return state;
}
describe('structured facts vs heuristics', () => {
  test('own win takes precedence over blocking; multiple opponent wins are not always a forced loss', () => {
    const p = sequence(row([3, 4, 5, 6], 7), row([0, 1, 2, 3], 0));
    const signals = positionSignals(p);
    expect(signals.priority).toBe('win-now');
    expect(signals.facts.immediateWins).toHaveLength(2);
    expect(signals.facts.opponentImmediateWins).toHaveLength(1);
    expect(signals.facts.unavoidableLossInOne).toBe(false);
    expect(signals.ruleset).toBe('free-gomoku/v1');
    expect(signals.heuristics.limitations.join(' ')).toContain('分数不是胜率');
  });
  test('an open opponent four with no own win cannot be stopped by one stone', () => {
    const p = sequence(row([3, 4, 5, 6], 7), row([0, 2, 4], 0));
    const signals = positionSignals(p);
    expect(signals.priority).toBe('answer-immediate-threat');
    expect(signals.facts.unavoidableLossInOne).toBe(true);
    const validation = validateCandidate(p, { x: 2, y: 7 });
    expect(validation.legal).toBe(true);
    expect(validation.opponentImmediateWinsAfter).toEqual([{ x: 7, y: 7 }]);
    expect(validation.warnings).toContain('对手下一手仍可立即成五');
  });
  test('one block removes a single threat, but is not a deep safety proof', () => {
    const p = sequence(row([0, 1, 2, 3], 7), row([0, 2, 4], 0)), before = structuredClone(p);
    expect(positionSignals(p).facts.unavoidableLossInOne).toBe(false);
    expect(validateCandidate(p, { x: 4, y: 7 })).toMatchObject({ legal: true, warnings: [], opponentImmediateWinsAfter: [], scope: 'one-ply-only' });
    expect(p).toEqual(before);
    expect(() => validateCandidate(p, { x: 0, y: 7 })).toThrow('已有棋子');
    expect(() => validateCandidate(p, { x: 99, y: 0 })).toThrow('坐标');
  });
  test('missed wins warn, winning moves leave no opponent replies, low-score legal moves remain allowed', () => {
    const p = sequence(row([3, 4, 5, 6], 7), row([0, 1, 2, 3], 0));
    expect(validateCandidate(p, { x: 14, y: 14 }).warnings).toContain('放弃了本手直接获胜点');
    expect(validateCandidate(p, { x: 2, y: 7 })).toMatchObject({ winner: 1, warnings: [], opponentImmediateWinsAfter: [] });
    expect(validateCandidate(emptyPosition(), { x: 0, y: 0 }).legal).toBe(true);
  });
  test('immediate fact scans match authoritative play at EVERY empty point, for both colors', () => {
    for (const p of [sequence(row([3, 4, 6, 7], 7), row([0, 2, 4, 6], 0)), sequence(row([3, 4, 5, 6], 7), row([0, 1, 2], 0))]) {
      const wins: Point[] = [], threats: Point[] = [];
      for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        if (p.board[y * SIZE + x]) continue;
        if (play(p, { x, y }).winner === p.next) wins.push({ x, y });
        if (play({ ...p, next: other(p.next) }, { x, y }).winner === other(p.next)) threats.push({ x, y });
      }
      expect(positionSignals(p).facts.immediateWins).toEqual(wins);
      expect(positionSignals(p).facts.opponentImmediateWins).toEqual(threats);
    }
  });
  test('terminal states have no actionable threats or candidates; double-three stays legal', () => {
    const terminal = sequence(row([0, 1, 2, 3, 4], 7), row([0, 2, 4, 6], 0));
    expect(positionSignals(terminal)).toMatchObject({ priority: 'terminal', facts: { immediateWins: [], opponentImmediateWins: [] }, heuristics: { candidates: [] } });
    expect(() => validateCandidate(terminal, { x: 10, y: 10 })).toThrow('结束');
    const cross = sequence([{ x: 6, y: 7 }, { x: 8, y: 7 }, { x: 7, y: 6 }, { x: 7, y: 8 }], row([0, 2, 4, 6], 0));
    expect(validateCandidate(cross, { x: 7, y: 7 }).legal).toBe(true);
  });
});
describe('playbook routing and advisory time projection', () => {
  test('opening, midgame and tactical finish route by facts, not stone count alone', () => {
    expect(turnGuidance(stateAt(), 1000).playbook).toBe('opening');
    const midgame = sequence([{ x: 2, y: 4 }, { x: 5, y: 5 }, { x: 8, y: 6 }, { x: 11, y: 7 }], row([0, 2, 4, 6], 0));
    expect(turnGuidance(stateAt(midgame), 1000).playbook).toBe('midgame');
    const earlyThreat = sequence(row([0, 1, 2, 3], 7), row([0, 2, 4], 0));
    expect(turnGuidance(stateAt(earlyThreat), 1000).playbook).toBe('endgame');
    expect(turnGuidance(stateAt(earlyThreat), 1000).steps.map(s => s.status)).toEqual(['pending', 'pending', 'pending', 'pending']);
  });
  test('byoyomi loss vs forfeit stay distinct; time pressure does not override own immediate win', () => {
    const p = sequence(row([3, 4, 5, 6], 7), row([0, 2, 4, 6], 0)), state = stateAt(p);
    state.clock.players[1].mainMs = 0;
    const before = structuredClone(state), guidance = turnGuidance(state, 46_001);
    expect(guidance.playbook).toBe('time-pressure'); expect(guidance.signals.priority).toBe('win-now');
    expect(guidance.time.untilPeriodLossMs).toBe(14_999);
    expect(guidance.time.untilForfeitMs).toBe(134_999);
    expect(guidance.time.periodsLeft).toBe(3);
    expect(state).toEqual(before);
  });
  test('absolute urgency at exact 15s threshold, delayed periods and terminal games', () => {
    const state = stateAt(); state.match.settings = { ...DEFAULT_SETTINGS, timeControl: 'absolute' };
    state.clock.players[1].mainMs = 20_000;
    expect(turnGuidance(state, 5_999).playbook).toBe('opening');
    expect(turnGuidance(state, 6_000)).toMatchObject({ playbook: 'time-pressure', time: { untilForfeitMs: 15_000, untilPeriodLossMs: 15_000 } });
    const overtime = stateAt(); overtime.clock.players[1].mainMs = 0;
    expect(turnGuidance(overtime, 121_001).time).toMatchObject({ periodsLeft: 1, untilPeriodLossMs: 59_999, untilForfeitMs: 59_999 });
    const ended = stateAt(); ended.outcome = { gameId: ended.id, number: 1, humanColor: 1, winner: 2, reason: 'resign' };
    expect(turnGuidance(ended, 1000).playbook).toBeNull();
  });
});
