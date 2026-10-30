import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { emptyPosition, other, play, positionFromPieces, replay, type Color, type Kind, type Piece } from '../src/business/engine';
import { reviewMove } from '../src/business/expert';
import { liveSearchOptions, mergeSearchReview } from '../src/business/live-search';
import { MATE_SCORE, searchPosition, staticScore } from '../src/business/search';
import { PASSIVE_GAME } from './fixtures/passive-game';
const full = { maxMs: 3000, maxNodes: 100000 };
const piece = (kind: Kind, color: Color, x: number, y: number): Piece => ({ id: `${color}-${kind}-${x}-${y}`, kind, color, x, y });

describe('bounded alternating search', () => {
  test('zero budget and incomplete roots are unknown, not arbitrary safe moves; no mutation', () => {
    const p = emptyPosition(), before = structuredClone(p);
    for (const options of [{ maxNodes: 0 }, { maxMs: 0 }, { maxNodes: 3 }]) {
      const report = searchPosition(p, { ...full, ...options });
      expect(report.completedDepth).toBe(0); expect(report.bestMove).toBeNull(); expect(report.rootScores).toEqual([]);
    }
    expect(p).toEqual(before);
  });
  test('only the last COMPLETE iteration survives a node cutoff', () => {
    const p = emptyPosition(), opts = { ...full, extensions: 0, quiescenceDepth: 0 };
    const first = searchPosition(p, { ...opts, maxDepth: 1 });
    const truncated = searchPosition(p, { ...opts, maxDepth: 3, maxNodes: first.nodes + 3 });
    expect(truncated.completedDepth).toBe(1); expect(truncated.attemptedDepth).toBe(2);
    expect(truncated.rootScores).toEqual(first.rootScores); expect(truncated.candidates).toEqual(first.candidates);
    expect(truncated.nodes).toBeLessThanOrEqual(first.nodes + 3);
  });
  test('mate beats positional/material heuristics, with a legally replayable PV', () => {
    const p = positionFromPieces([piece('king', 1, 4, 9), piece('king', 2, 4, 0), piece('pawn', 1, 4, 5),
      piece('rook', 1, 3, 1), piece('rook', 1, 5, 1), piece('rook', 1, 0, 2)]);
    const winning = { from: { x: 0, y: 2 }, to: { x: 4, y: 2 } };
    const s = searchPosition(p, { ...full, moves: [winning], maxDepth: 2 });
    expect(s.candidates[0].score).toBeGreaterThan(MATE_SCORE - 100);
    let q = p; for (const m of s.candidates[0].pv) q = play(q, m);
    expect(q.winner).toBe(1); expect(Math.abs(staticScore(p))).toBeLessThan(50001);
  });
  test('subset scope is explicit; illegal and oversized candidate lists rejected', () => {
    const p = emptyPosition(), move = { from: { x: 0, y: 6 }, to: { x: 0, y: 5 } };
    const s = searchPosition(p, { ...full, moves: [move, move], maxDepth: 1 });
    expect(s.rootScope).toBe('requested-subset'); expect(s.searchedRoots).toBe(1); expect(s.legalRoots).toBe(44);
    expect(() => searchPosition(p, { moves: [] })).toThrow();
    expect(() => searchPosition(p, { moves: Array(7).fill(move) })).toThrow();
    expect(() => searchPosition(p, { moves: [{ from: { x: 0, y: 6 }, to: { x: 1, y: 6 } }] })).toThrow();
  });
  test('cancellation, terminal positions and color symmetry', () => {
    const c = new AbortController(); c.abort();
    expect(searchPosition(emptyPosition(), { signal: c.signal }).stopped).toBe('cancelled');
    const end = replay(PASSIVE_GAME); expect(searchPosition(end).stopped).toBe('terminal');
    const p = replay(PASSIVE_GAME.slice(0, 29));
    const q = positionFromPieces(p.board.filter(Boolean).map(x => ({ ...x!, color: other(x!.color), x: 8 - x!.x, y: 9 - x!.y })), other(p.next));
    // The synthetic rotation has no move history; compare with the SAME phase.
    expect(staticScore(p, p.next, 'middlegame')).toBe(staticScore(q, q.next, 'middlegame'));
    expect(staticScore(p, 1)).toBe(-staticScore(p, 2));
  });
});

describe('actual passive-loss regression', () => {
  test('53 plies replay to red mate; a deeper comparison rejects local least-loss reasoning', () => {
    expect(replay(PASSIVE_GAME)).toMatchObject({ winner: 1, endReason: 'checkmate' });
    const p = replay(PASSIVE_GAME.slice(0, 45));
    const s = searchPosition(p, { ...full, moves: [PASSIVE_GAME[45], { from: { x: 4, y: 1 }, to: { x: 6, y: 0 } }],
      maxDepth: 4, quiescenceDepth: 3, extensions: 2 });
    expect(s.completedDepth).toBe(4); expect(s.candidates[0].move.from).toEqual({ x: 4, y: 1 });
    // Preference is bounded, not a claim that the alternative draws or wins.
  });
  test('multi-ply bottom-cannon/rook kill upgrades SEE risk to a searched loss', () => {
    const p = replay(PASSIVE_GAME.slice(0, 47)), move = PASSIVE_GAME[47];
    const local = reviewMove(p, move, { maxMs: 10000, maxNodes: 50000 });
    expect(local.losingReply).toBeNull(); expect(local.risk).not.toBe('loss');
    const search = searchPosition(p, { ...full, moves: [move], maxDepth: 4, quiescenceDepth: 3, extensions: 2 });
    const combined = mergeSearchReview(p, local, search);
    expect(search.completedDepth).toBe(4); expect(combined.risk).toBe('loss'); expect(combined.variation.length).toBeGreaterThan(2);
    expect(combined.search).toBe(search);
    let q = p; for (const m of combined.variation) q = play(q, m);
    expect(q.winner).toBe(1);
    const truncated = mergeSearchReview(p, local, { ...search, completedDepth: 0 });
    expect(truncated.risk).toBe(local.risk); expect(truncated.warnings.join('')).toContain('未知');
    const forgedLine = structuredClone(search); forgedLine.candidates[0].pv = [move];
    expect(mergeSearchReview(p, local, forgedLine).risk).toBe(local.risk);
  });
  test('danger gets more time, low clocks shrink it, and caller requests stay bounded', () => {
    const quiet = liveSearchOptions(emptyPosition(), 600000), danger = liveSearchOptions(replay(PASSIVE_GAME.slice(0, 47)), 600000);
    expect(danger.maxMs!).toBeGreaterThan(quiet.maxMs!);
    expect(liveSearchOptions(emptyPosition(), 120).maxMs).toBe(10);
    const bounded = liveSearchOptions(emptyPosition(), 600000, { maxMs: 99999, maxNodes: 999999, maxDepth: 99 });
    expect(bounded.maxMs).toBe(1000); expect(bounded.maxNodes).toBe(30000); expect(bounded.maxDepth).toBe(6);
  });
});

describe('real search Worker boundary', () => {
  let dir: string, workerFile: string, driverFile: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'xiangqi-search-')); workerFile = path.join(dir, 'search.js');
    const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, '../src/learning/search-worker.ts')], target: 'node', format: 'esm' });
    if (!built.success) throw new Error('search worker build failed');
    await writeFile(workerFile, await built.outputs[0].text());
    driverFile = path.join(dir, 'driver.mjs');
    const driver = await Bun.build({ entrypoints: [path.join(import.meta.dir, '../src/learning/search-driver.ts')], target: 'node', format: 'esm' });
    if (!driver.success) throw new Error('search driver build failed');
    await writeFile(driverFile, await driver.outputs[0].text());
  });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
  async function probe(body: string) {
    // Electron runs Node workers. Bun's worker shim can exceed the production
    // startup watchdog under the test runner; test the real Node boundary,
    // rather than loosening that watchdog or retrying a fake safe result.
    const file = path.join(dir, 'probe.mjs');
    await writeFile(file, `import { WorkerSearchDriver } from ${JSON.stringify(pathToFileURL(driverFile).href)};
      const p = ${JSON.stringify(emptyPosition())}; ${body}`);
    const child = Bun.spawn(['node', file], { stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Node search probe failed: ${stderr}`);
    return JSON.parse(stdout);
  }
  test('actual Node worker returns a scoped report without mutating authority', async () => {
    const move = { from: { x: 0, y: 6 }, to: { x: 0, y: 5 } };
    const { report, position } = await probe(`const r = await new WorkerSearchDriver(${JSON.stringify(workerFile)}).search(p,
      { moves: [${JSON.stringify(move)}], maxMs: 1200, maxDepth: 1, extensions: 0, quiescenceDepth: 0 }, new AbortController().signal);
      console.log(JSON.stringify({ report: r, position: p }));`);
    expect(report.completedDepth).toBe(1); expect(report.rootScope).toBe('requested-subset'); expect(position).toEqual(emptyPosition());
  });
  test('abort terminates pending worker work, including an already-aborted call', async () => {
    const slow = path.join(dir, 'slow.mjs'); await writeFile(slow, 'setInterval(() => {}, 1000);');
    const errors = await probe(`const errors = [], c = new AbortController(); c.abort();
      try { await new WorkerSearchDriver(${JSON.stringify(workerFile)}).search(p, {}, c.signal); } catch (e) { errors.push(e.message); }
      const abort = new AbortController(), work = new WorkerSearchDriver(${JSON.stringify(slow)}).search(p, { maxMs: 1000 }, abort.signal);
      setTimeout(() => abort.abort(), 10);
      try { await work; } catch (e) { errors.push(e.message); }
      console.log(JSON.stringify(errors));`);
    expect(errors).toHaveLength(2); expect(errors[0]).toContain('取消'); expect(errors[1]).toContain('取消');
  });
  test('worker early exit and hard timeout return unknown errors, not fake safe scores', async () => {
    const exit = path.join(dir, 'exit.mjs'); await writeFile(exit, 'process.exit(0);');
    const slow = path.join(dir, 'timeout.mjs'); await writeFile(slow, 'setInterval(() => {}, 1000);');
    const errors = await probe(`const errors = [];
      try { await new WorkerSearchDriver(${JSON.stringify(exit)}).search(p, {}, new AbortController().signal); } catch (e) { errors.push(e.message); }
      try { await new WorkerSearchDriver(${JSON.stringify(slow)}).search(p, { maxMs: 10 }, new AbortController().signal); } catch (e) { errors.push(e.message); }
      console.log(JSON.stringify(errors));`);
    expect(errors).toHaveLength(2); expect(errors[0]).toContain('提前退出'); expect(errors[1]).toContain('硬时限');
  });
});
