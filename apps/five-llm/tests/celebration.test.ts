import { describe, expect, test } from 'bun:test';
import { GameService } from '../src/business/game-service';
import { isNewHumanWin } from '../src/renderer/celebration';
import type { GameState, ResultReason } from '../src/shared/types';

function fixture(human: 1 | 2 = 1): GameState {
  const service = new GameService({ async run() {} }, null);
  return service.newGame(human);
}
function settled(state: GameState, winner: 1 | 2 | 'draw', reason: ResultReason = 'five'): GameState {
  return { ...state, status: 'over', outcome: { gameId: state.id, number: 1, humanColor: state.human, winner, reason } };
}

describe('human victory celebration trigger', () => {
  test('celebrates either human color and all authoritative winning reasons', () => {
    for (const human of [1, 2] as const) for (const reason of ['five', 'main-time', 'byoyomi', 'resign'] as const) {
      const before = fixture(human);
      expect(isNewHumanWin(before, settled(before, human, reason))).toBe(true);
    }
  });
  test('does not celebrate a loss, draw, or unfinished round', () => {
    const before = fixture();
    expect(isNewHumanWin(before, settled(before, 2))).toBe(false);
    expect(isNewHumanWin(before, settled(before, 'draw', 'draw'))).toBe(false);
    expect(isNewHumanWin(before, before)).toBe(false);
  });
  test('bootstrap, duplicate replies, heartbeats and model changes cannot replay a win', () => {
    const before = fixture(), win = settled(before, 1);
    expect(isNewHumanWin(undefined, win)).toBe(false);
    expect(isNewHumanWin(win, structuredClone(win))).toBe(false);
    expect(isNewHumanWin(win, { ...win, revision: win.revision + 1 })).toBe(false);
    expect(isNewHumanWin(before, { ...win, id: 'another-round' })).toBe(false);
  });
  test('later rounds and the match-winning round celebrate normally', () => {
    const before = fixture(2), win = settled(before, 2);
    win.match.winner = 'human';
    expect(isNewHumanWin(before, win)).toBe(true);
    const nextRound = { ...before, id: 'next-round' };
    expect(isNewHumanWin(nextRound, settled(nextRound, 2))).toBe(true);
  });
});
