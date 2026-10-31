import { describe, expect, test } from 'bun:test';
import { analyze, coordinate, emptyPosition, play, SIZE, type Point, type Position } from '../src/business/engine';
import { findOwnForcingWin, type ForcingProof } from '../src/business/forcing';
import { missedWhiteWinCase as fixture, missedWhiteWinPosition, point } from './fixtures/positions';

function verifyOwnProof(original: Position, proof: ForcingProof): void {
  expect(proof.attacker).toBe(original.next);
  let p = original;
  for (const [i, move] of proof.line.entries()) {
    if (i % 2 === 1) {
      expect(analyze(p).winningMoves).toEqual([]); // No defender counter-win.
      expect(analyze(p).mustBlock).toEqual([move]);
      // Every non-blocking legal reply really loses next move.
      for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        if (p.board[y * SIZE + x] || (x === move.x && y === move.y)) continue;
        const reply = play(p, { x, y });
        expect(reply.winner).toBeNull(); expect(play(reply, move).winner).toBe(proof.attacker);
      }
    }
    p = play(p, move);
  }
  if (proof.terminal === 'five') expect(p.winner).toBe(proof.attacker);
  else {
    expect(analyze(p).winningMoves).toEqual([]);
    expect(analyze(p).mustBlock.map(coordinate)).toEqual(proof.winningPoints.map(coordinate));
    expect(proof.winningPoints.length).toBeGreaterThan(1);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (!p.board[y * SIZE + x]) {
      const reply = play(p, { x, y });
      expect(reply.winner).toBeNull();
      const finish = proof.winningPoints.find(m => !reply.board[m.y * SIZE + m.x]);
      expect(finish).toBeDefined(); expect(play(reply, finish!).winner).toBe(proof.attacker);
    }
  }
}

describe('own continuous-four win discovery', () => {
  test('automatically discovers a G10 forcing win without heuristic ranking or mutation', async () => {
    const p = missedWhiteWinPosition(), before = structuredClone(p);
    const r = await findOwnForcingWin(p);
    expect(r).toMatchObject({ status: 'found-forced-win', scope: 'own-continuous-four-only', winningCandidate: 'G10', reason: 'continuous-four' });
    // The original short J7 finish is covered in missed-win-case.test.ts;
    // another fully verified forcing continuation is equally valid, not a regression.
    expect(r.proof!.line.slice(0, 2).map(coordinate)).toEqual(['G10', 'G8']);
    verifyOwnProof(p, r.proof!); expect(p).toEqual(before);
  });
  test('proofs generalize to all rotations/reflections and a black attacker', async () => {
    for (let reflect = 0; reflect < 2; reflect++) for (let rotations = 0; rotations < 4; rotations++) {
      const transform = (p: Point): Point => {
        let x = reflect ? SIZE - 1 - p.x : p.x, y = p.y;
        for (let i = 0; i < rotations; i++) [x, y] = [SIZE - 1 - y, x];
        return { x, y };
      };
      const p = fixture.moves.reduce((p, s) => play(p, transform(point(s))), emptyPosition());
      const r = await findOwnForcingWin(p);
      expect(r.status).toBe('found-forced-win');
      expect(r.winningCandidate).toBe(coordinate(r.proof!.line[0])); verifyOwnProof(p, r.proof!);
    }
    // One remote black opening swaps the attackers while retaining a legal history.
    const black = fixture.moves.reduce((p, s) => play(p, point(s)), play(emptyPosition(), point('A1')));
    const r = await findOwnForcingWin(black);
    expect(r.status).toBe('found-forced-win'); expect(r.proof!.attacker).toBe(1); verifyOwnProof(black, r.proof!);
  });
  test('own immediate win outruns the opponent immediate win; terminal positions do not fabricate another proof', async () => {
    const p = ['D8', 'A15', 'E8', 'B15', 'F8', 'C15', 'G8', 'D15'].reduce((p, s) => play(p, point(s)), emptyPosition());
    const r = await findOwnForcingWin(p);
    expect(r.status).toBe('found-forced-win'); expect(r.proof!.terminal).toBe('five'); verifyOwnProof(p, r.proof!);
    const won = play(p, r.proof!.line[0]);
    expect(await findOwnForcingWin(won)).toMatchObject({ status: 'not-found-within-budget', reason: 'terminal-position', nodes: 0 });
  });
  test('an opponent counter-win invalidates a superficially attractive attacking four', async () => {
    const p = ['D8', 'A15', 'E8', 'B15', 'F8', 'C15', 'M3', 'E15'].reduce((p, s) => play(p, point(s)), emptyPosition());
    // White threatens D15 now. Extending black D8/E8/F8 must not be called a win.
    const r = await findOwnForcingWin(p);
    expect(r.status).toBe('not-found-within-budget'); expect(r.proof).toBeUndefined();
  });
  test('empty and shallow searches stay qualified negatives, never no-win or safe claims', async () => {
    expect(await findOwnForcingWin(emptyPosition())).toMatchObject({ status: 'not-found-within-budget', reason: 'depth-exhausted' });
    const shallow = await findOwnForcingWin(missedWhiteWinPosition(), { maxAttackMoves: 1 });
    expect(shallow.status).toBe('not-found-within-budget'); expect(shallow.proof).toBeUndefined();
  });
  test('budgets, monotonic deadline and cancellation return incomplete without a proof', async () => {
    const p = missedWhiteWinPosition();
    for (const options of [{ maxNodes: 0 }, { maxNodes: 1 }, { maxMs: 0 }]) {
      const r = await findOwnForcingWin(p, options);
      expect(r.status).toBe('incomplete'); expect(r.proof).toBeUndefined(); expect(r.winningCandidate).toBeUndefined();
      expect(r.nodes).toBeLessThanOrEqual(options.maxNodes ?? 6000);
    }
    let t = 0;
    expect(await findOwnForcingWin(p, { maxMs: 2, now: () => t++ })).toMatchObject({ status: 'incomplete', reason: 'time-budget' });
    const c = new AbortController(); c.abort();
    expect(await findOwnForcingWin(p, { signal: c.signal })).toMatchObject({ status: 'incomplete', reason: 'aborted' });
    const active = new AbortController(), timer = setTimeout(() => active.abort(), 0);
    try { expect(await findOwnForcingWin(p, { signal: active.signal })).toMatchObject({ status: 'incomplete', reason: 'aborted' }); }
    finally { clearTimeout(timer); }
    for (const options of [{ maxMs: 501 }, { maxNodes: -1 }, { maxAttackMoves: 5 }]) await expect(findOwnForcingWin(p, options)).rejects.toThrow('预算');
  });
});
