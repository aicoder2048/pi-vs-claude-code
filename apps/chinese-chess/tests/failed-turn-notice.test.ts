import { expect, test } from 'bun:test';
import { failedTurnNotice } from '../src/renderer/turn-feedback';
import type { GameState } from '../src/shared/types';
import type { TurnAttempt } from '../src/business/turn-timing';

const attempt: TurnAttempt = { id: 'budget', revision: 33, ply: 34, model: 'fixture', status: 'error', error: '8 次请求上限',
  timing: { version: 'xiangqi-timing/v1', totalMs: 23475, spans: [],
    breakdown: { modelMs: 0, toolMs: 0, preSearchMs: 0, reviewMs: 0, otherMs: 23475 } } };
const failed: Pick<GameState, 'status' | 'error' | 'attempts' | 'notes' | 'outcome'> = {
  status: 'error', error: attempt.error!, attempts: [attempt], notes: [], outcome: null,
};
test('persistent failure notice explains stopped work, running clock and retry action', () => {
  const text = failedTurnNotice(failed);
  expect(text).toContain('8 次请求上限'); expect(text).toContain('请求已停止');
  expect(text).toContain('棋钟仍在运行'); expect(text).toContain('继续 / 重试');
});
test('clock outcome does not erase the earlier cause, but retry/success/undo hide the warning', () => {
  const over = { ...failed, status: 'over' as const, error: null,
    outcome: { gameId: 'fixture', number: 1, humanColor: 1 as const, winner: 1 as const, reason: 'main-time' as const } };
  expect(failedTurnNotice(over)).toContain('8 次请求上限');
  expect(failedTurnNotice(over)).not.toContain('棋钟仍在运行');
  expect(failedTurnNotice({ ...failed, status: 'thinking', error: null })).toBeNull();
  expect(failedTurnNotice({ ...failed, status: 'human', error: null })).toBeNull();
  expect(failedTurnNotice({ ...over, notes: [{ ply: 34, reason: '成功落子', model: 'fixture', elapsedMs: 1 }] })).toBeNull();
  expect(failedTurnNotice({ ...over, attempts: [{ ...attempt, error: undefined }] })).toContain('未保存具体失败原因');
});
