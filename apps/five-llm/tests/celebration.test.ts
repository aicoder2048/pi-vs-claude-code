import { describe, expect, test } from 'bun:test';
import { GameService } from '../src/business/game-service';
import { newRoundWinner } from '../src/renderer/celebration';
import type { GameState, ResultReason } from '../src/shared/types';

function fixture(human: 1 | 2 = 1): GameState {
  const service = new GameService({ async run() {} }, null);
  return service.newGame(human);
}
function settled(state: GameState, winner: 1 | 2 | 'draw', reason: ResultReason = 'five'): GameState {
  return { ...state, status: 'over', outcome: { gameId: state.id, number: 1, humanColor: state.human, winner, reason } };
}

describe('round result celebration trigger', () => {
  test('a human win of either color and every winning reason celebrates the human', () => {
    for (const human of [1, 2] as const) for (const reason of ['five', 'main-time', 'byoyomi', 'resign'] as const) {
      const before = fixture(human);
      expect(newRoundWinner(before, settled(before, human, reason))).toBe('human');
    }
  });
  test('a machine win of either color gets the machine effect', () => {
    for (const human of [1, 2] as const) for (const reason of ['five', 'main-time', 'resign'] as const) {
      const before = fixture(human);
      expect(newRoundWinner(before, settled(before, human === 1 ? 2 : 1, reason))).toBe('machine');
    }
  });
  test('a draw or unfinished round plays nothing', () => {
    const before = fixture();
    expect(newRoundWinner(before, settled(before, 'draw', 'draw'))).toBeNull();
    expect(newRoundWinner(before, before)).toBeNull();
  });
  test('bootstrap, duplicate replies, heartbeats and model changes cannot replay a result', () => {
    for (const winner of [1, 2] as const) {
      const before = fixture(), result = settled(before, winner);
      expect(newRoundWinner(undefined, result)).toBeNull();
      expect(newRoundWinner(result, structuredClone(result))).toBeNull();
      expect(newRoundWinner(result, { ...result, revision: result.revision + 1 })).toBeNull();
      expect(newRoundWinner(before, { ...result, id: 'another-round' })).toBeNull();
    }
  });
  test('later rounds and match-deciding rounds celebrate normally', () => {
    const before = fixture(2), win = settled(before, 2);
    win.match.winner = 'human';
    expect(newRoundWinner(before, win)).toBe('human');
    const nextRound = { ...before, id: 'next-round' };
    expect(newRoundWinner(nextRound, settled(nextRound, 1))).toBe('machine');
  });
});
