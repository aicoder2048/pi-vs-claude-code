import { expect, test } from 'bun:test';
import { at, inCheck, legalCaptures, legalMoves, play, replay } from '../src/business/engine';
import { REQUEST_BUDGET_GAME } from './fixtures/request-budget-game';

test('recorded ply 33 is a legal horse fork, not check, mate or a rules lockout', () => {
  const before = replay(REQUEST_BUDGET_GAME.slice(0, 32));
  const position = play(before, REQUEST_BUDGET_GAME[32]!);
  expect(position.moves.at(-1)?.notation).toBe('红马 D5 → F4');
  expect(position.winner).toBeNull();
  expect(inCheck(position.board, 1)).toBe(false);
  expect(inCheck(position.board, 2)).toBe(false);
  expect(legalMoves(position)).toHaveLength(39);
  const targets = legalCaptures({ ...position, next: 1 })
    .filter(m => m.from.x === 5 && m.from.y === 4)
    .map(m => at(position.board, m.to));
  expect(targets).toHaveLength(2);
  expect(targets.map(p => [p?.kind, p?.x, p?.y])).toEqual([
    ['horse', 6, 2], ['horse', 4, 6],
  ]);
  // A real legal response still exists; no local move should be forced instead
  // of asking the LLM to choose its response.
  expect(play(position, { from: { x: 8, y: 1 }, to: { x: 2, y: 1 } }).moves).toHaveLength(34);
});
