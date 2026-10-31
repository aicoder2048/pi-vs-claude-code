import { describe, expect, test } from 'bun:test';
import { checkForcingSequences } from '../src/business/forcing';
import { analyze, coordinate, emptyPosition, other, play, type Point, type Position } from '../src/business/engine';
import { humanWinCase as fixture, humanWinPosition, point } from './fixtures/positions';

function verifyProof(position: Position, candidate: Point, proof: NonNullable<Awaited<ReturnType<typeof checkForcingSequences>>['proof']>) {
  let p = play(position, candidate);
  for (const [i, move] of proof.line.entries()) {
    if (i % 2 === 1) {
      const a = analyze(p);
      expect(a.winningMoves).toEqual([]);
      expect(a.mustBlock.map(coordinate)).toEqual([coordinate(move)]);
    }
    p = play(p, move);
  }
  if (proof.terminal === 'five') expect(p.winner).toBe(proof.attacker);
  else {
    const a = analyze(p);
    expect(a.winningMoves).toEqual([]);
    expect(a.mustBlock.map(coordinate)).toEqual(proof.winningPoints.map(coordinate));
    expect(a.mustBlock.length).toBeGreaterThan(1);
    // Exhaustively verify EVERY legal defender reply, not just a sample line.
    for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) if (!p.board[y * 15 + x]) {
      const reply = play(p, { x, y });
      expect(reply.winner).not.toBe(other(proof.attacker));
      expect(analyze(reply).winningMoves.length).toBeGreaterThan(0);
    }
  }
}
describe('bounded continuous-four candidate refutation', () => {
  test('finds the live-game forced line without mutating input; proof survives every final reply', async () => {
    const p = humanWinPosition(), before = structuredClone(p);
    const result = await checkForcingSequences(p, point(fixture.candidate));
    expect(result.status).toBe('found-forced-loss');
    expect(result.proof!.line.map(coordinate)).toEqual(fixture.refutation);
    expect(result.proof!.winningPoints.map(coordinate)).toEqual(fixture.winningPoints);
    expect(result.scope).toBe('opponent-continuous-four-only');
    verifyProof(p, point(fixture.candidate), result.proof!);
    expect(p).toEqual(before);
  });
  test('the live-game proof generalizes to every board rotation/reflection, not hardcoded coordinates', async () => {
    for (let reflect = 0; reflect < 2; reflect++) for (let rotations = 0; rotations < 4; rotations++) {
      const transform = (p: Point): Point => {
        let x = reflect ? 14 - p.x : p.x, y = p.y;
        for (let i = 0; i < rotations; i++) [x, y] = [14 - y, x];
        return { x, y };
      };
      const p = humanWinPosition().moves.reduce((p, m) => play(p, transform(m)), emptyPosition());
      const candidate = transform(point('H7'));
      const result = await checkForcingSequences(p, candidate);
      expect(result.status).toBe('found-forced-loss');
      verifyProof(p, candidate, result.proof!);
      expect(result.nodes).toBeLessThanOrEqual(result.budget.maxNodes);
      expect(result.elapsedMs).toBeLessThan(result.budget.maxMs);
    }
  });
  test('I11 breaks the known kill; negative bounded search is not a safety claim', async () => {
    const result = await checkForcingSequences(humanWinPosition(), point(fixture.alternative));
    expect(result.status).toBe('not-found-within-budget'); expect(result.proof).toBeUndefined();
    expect(result.reason).toBe('depth-exhausted');
    expect(result.budget.maxAttackMoves).toBe(3);
    const shallow = await checkForcingSequences(humanWinPosition(), point('H7'), { maxAttackMoves: 1 });
    expect(shallow.status).toBe('not-found-within-budget');
  });
  test('empty/developing positions do not fabricate a forcing proof', async () => {
    const result = await checkForcingSequences(emptyPosition(), point('H8'));
    expect(result.status).toBe('not-found-within-budget'); expect(result.nodes).toBe(1);
  });
  test('own immediate win takes precedence even when the opponent also has a winning point', async () => {
    let p = emptyPosition();
    for (const c of ['D8', 'A15', 'E8', 'B15', 'F8', 'C15', 'G8', 'D15']) p = play(p, point(c));
    const result = await checkForcingSequences(p, point('C8'), { maxNodes: 0, maxMs: 0 });
    expect(result).toMatchObject({ status: 'not-found-within-budget', reason: 'candidate-wins', nodes: 0 });
  });
  test('an opponent immediate win is a proof, including a broken four', async () => {
    let p = emptyPosition();
    for (const c of ['D8', 'A15', 'E8', 'C15', 'G8', 'E15', 'H8']) p = play(p, point(c));
    const result = await checkForcingSequences(p, point('O1'));
    expect(result.status).toBe('found-forced-loss'); expect(result.proof!.terminal).toBe('five');
    verifyProof(p, point('O1'), result.proof!);
  });
  test('freestyle overline remains an immediate win and a full-board draw does not start a search', async () => {
    let p = emptyPosition();
    for (const c of ['A8', 'A15', 'B8', 'C15', 'C8', 'E15', 'E8', 'G15', 'F8', 'I15']) p = play(p, point(c));
    expect(await checkForcingSequences(p, point('D8'))).toMatchObject({ reason: 'candidate-wins', nodes: 0 });
    const black: Point[] = [], white: Point[] = [];
    for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) ((x + Math.floor(y / 2)) % 2 === 0 ? black : white).push({ x, y });
    p = emptyPosition();
    for (let i = 0; i < 112; i++) { p = play(p, black[i]); p = play(p, white[i]); }
    expect(await checkForcingSequences(p, black[112])).toMatchObject({ reason: 'candidate-draw', nodes: 0 });
  });
  test('does not mistake an attacking four for a win when the defender can win first', async () => {
    let p = emptyPosition();
    for (const c of ['D8', 'A15', 'E8', 'B15', 'F8', 'C15', 'M3']) p = play(p, point(c));
    const result = await checkForcingSequences(p, point('D15'));
    expect(result.status).toBe('not-found-within-budget'); expect(result.proof).toBeUndefined();
  });
  test('zero/exhausted budgets return incomplete, never not-found or safe', async () => {
    for (const options of [{ maxNodes: 0 }, { maxNodes: 1 }, { maxMs: 0 }]) {
      const r = await checkForcingSequences(humanWinPosition(), point('H7'), options);
      expect(r.status).toBe('incomplete'); expect(r.proof).toBeUndefined(); expect(r.nodes).toBeLessThanOrEqual(options.maxNodes ?? 6000);
    }
    let t = 0;
    expect(await checkForcingSequences(humanWinPosition(), point('H7'), { maxMs: 2, now: () => t++ })).toMatchObject({ status: 'incomplete', reason: 'time-budget' });
  });
  test('cancellation is reported and periodic yields allow timers to cancel work', async () => {
    const c = new AbortController(); c.abort();
    expect(await checkForcingSequences(humanWinPosition(), point('H7'), { signal: c.signal })).toMatchObject({ status: 'incomplete', reason: 'aborted' });
    const active = new AbortController();
    const timer = setTimeout(() => active.abort(), 0);
    try {
      const result = await checkForcingSequences(humanWinPosition(), point('I11'), { signal: active.signal, maxAttackMoves: 4 });
      expect(result).toMatchObject({ status: 'incomplete', reason: 'aborted' });
    } finally { clearTimeout(timer); }
  });
  test('invalid legality/budgets throw instead of generating false evidence', async () => {
    await expect(checkForcingSequences(humanWinPosition(), point('H8'))).rejects.toThrow('已有棋子');
    for (const options of [{ maxMs: 501 }, { maxNodes: -1 }, { maxAttackMoves: 5 }, { maxAttackMoves: 1.5 }]) {
      await expect(checkForcingSequences(humanWinPosition(), point('H7'), options)).rejects.toThrow('预算');
    }
  });
});
