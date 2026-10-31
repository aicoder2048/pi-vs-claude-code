import { expect, test } from 'bun:test';
import { analyze, coordinate, play } from '../src/business/engine';
import { validateCandidate } from '../src/business/decision';
import { humanWinCase as fixture, humanWinPosition, point } from './fixtures/positions';

test('live-game fixture: one-ply-safe H7 permits forced replies followed by an open four', () => {
  const original = humanWinPosition();
  expect(original.moves).toHaveLength(21); expect(original.next).toBe(2);
  expect(validateCandidate(original, point(fixture.candidate)).warnings).toEqual([]);
  let p = play(original, point(fixture.candidate));
  for (const [i, move] of fixture.refutation.entries()) {
    p = play(p, point(move));
    if (i === 0 || i === 2) {
      const a = analyze(p);
      expect(a.winningMoves).toEqual([]);
      expect(a.mustBlock.map(coordinate)).toEqual([fixture.refutation[i + 1]]);
    }
  }
  expect(analyze(p).winningMoves).toEqual([]);
  expect(analyze(p).mustBlock.map(coordinate)).toEqual(fixture.winningPoints);
  p = play(p, point('I11')); p = play(p, point('N11'));
  expect(p.winner).toBe(1);
  // I11 breaks THIS open-four finish, not a proof of global safety.
  p = play(original, point(fixture.alternative));
  for (const move of fixture.refutation) p = play(p, point(move));
  expect(analyze(p).mustBlock.map(coordinate)).toEqual(['N11']);
  expect(analyze(play(p, point('N11'))).mustBlock).toEqual([]);
});
