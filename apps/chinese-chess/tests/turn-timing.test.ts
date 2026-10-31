import { describe, expect, test } from 'bun:test';
import { recordSaveKey, TurnTimer } from '../src/business/turn-timing';
import { GameService, type TurnPort } from '../src/business/game-service';
import { DEFAULT_SETTINGS } from '../src/business/clock';
import { searchPosition } from '../src/business/search';
import { normalizeRecord } from '../src/business/learning';
const model = { provider: 'test', id: 'timing', name: 'timing' };
const red = { from: { x: 0, y: 6 }, to: { x: 0, y: 5 } };
const black = { from: { x: 0, y: 3 }, to: { x: 0, y: 4 } };
function sum(t: ReturnType<TurnTimer['snapshot']>) { return Object.values(t.breakdown).reduce((a, b) => a + b, 0); }

describe('wall-clock timing, not reasoning traces', () => {
  test('exclusive breakdown and first delta, with commit finalized inside the transaction', () => {
    let now = 0; const t = new TurnTimer(() => now, 7);
    t.event({ type: 'start', id: 'setup', kind: 'setup', name: 'session' });
    now = 10; t.event({ type: 'end', id: 'setup', ok: true });
    t.event({ type: 'start', id: 'pre', kind: 'pre-search', name: 'auto' });
    now = 60; t.event({ type: 'end', id: 'pre', ok: true });
    t.event({ type: 'start', id: 'model', kind: 'model', name: 'request-1' });
    expect(t.progress()).toMatchObject({ phase: 'model', receiving: false, requests: 1 });
    now = 90; t.event({ type: 'first-delta', id: 'model' });
    expect(t.progress().receiving).toBe(true);
    now = 100; expect(t.event({ type: 'first-delta', id: 'model' })).toBe(false);
    now = 160; t.event({ type: 'end', id: 'model', ok: true });
    t.event({ type: 'start', id: 'compare', kind: 'tool', name: 'compare_moves' });
    now = 180; t.event({ type: 'end', id: 'compare', ok: true });
    t.event({ type: 'start', id: 'move', kind: 'tool', name: 'move_piece' });
    now = 190; t.event({ type: 'start', id: 'review', kind: 'review', name: 'independent-review' });
    now = 230; t.event({ type: 'end', id: 'review', ok: true });
    now = 240; const timing = t.finish(true);
    expect(timing.breakdown).toEqual({ modelMs: 100, toolMs: 40, preSearchMs: 50, reviewMs: 40, otherMs: 10 });
    expect(timing.totalMs).toBe(240); expect(sum(timing)).toBe(240);
    expect(timing.spans.find(s => s.id === 'model')?.firstDeltaMs).toBe(30);
    expect(timing.spans.at(-2)?.status).toBe('ok');
    now = 900; expect(t.event({ type: 'end', id: 'move', ok: false })).toBe(false);
    expect(t.snapshot()).toEqual(timing);
    timing.spans.length = 0; expect(t.snapshot().spans).toHaveLength(6);
  });
  test('overlapping and nested spans are not double-counted; failure freezes open spans', () => {
    let now = 0; const t = new TurnTimer(() => now, 1);
    t.event({ type: 'start', id: 'm', kind: 'model', name: 'request-1' });
    now = 10; t.event({ type: 'start', id: 'a', kind: 'tool', name: 'compare_moves' });
    now = 20; t.event({ type: 'start', id: 'b', kind: 'tool', name: 'review_move' });
    now = 40; t.event({ type: 'end', id: 'm', ok: true });
    now = 50; t.event({ type: 'start', id: 'r', kind: 'review', name: 'review' });
    now = 70; t.event({ type: 'end', id: 'r', ok: false });
    now = 80; t.event({ type: 'end', id: 'b', ok: false });
    now = 100; const timing = t.finish();
    expect(timing.breakdown).toMatchObject({ modelMs: 10, toolMs: 70, reviewMs: 20, otherMs: 0 });
    expect(sum(timing)).toBe(timing.totalMs);
    expect(timing.spans.find(s => s.id === 'a')?.status).toBe('interrupted');
    now = -5; expect(t.snapshot()).toEqual(timing);
  });
});

describe('timing lifecycle and persistence', () => {
  test('accepted note contains complete timing on the first saveable notification', async () => {
    let now = 0, port!: TurnPort;
    const service = new GameService({ async run(p) { port = p; await new Promise(() => {}); } }, model, { now: () => now,
      search: { async search(p) { now += 200; return searchPosition(p, { maxMs: 0, maxNodes: 0 }); } } });
    service.humanMove(red, 0);
    const firstSequence = service.snapshot().updateSequence!, clockAt = service.snapshot().clock.updatedAt;
    port.telemetry!({ type: 'start', id: 'model', kind: 'model', name: 'request-1' });
    expect(service.snapshot().updateSequence).toBeGreaterThan(firstSequence);
    expect(service.snapshot().clock.updatedAt).toBe(clockAt); // stage ordering does not change chess clocks
    now = 500; port.telemetry!({ type: 'first-delta', id: 'model' });
    now = 1000; port.telemetry!({ type: 'end', id: 'model', ok: true });
    port.telemetry!({ type: 'start', id: 'compare', kind: 'tool', name: 'compare_moves' });
    now = 1100; port.telemetry!({ type: 'end', id: 'compare', ok: true });
    port.telemetry!({ type: 'start', id: 'commit', kind: 'tool', name: 'move_piece' });
    const records: ReturnType<GameService['record']>[] = [];
    service.subscribe(() => { if (service.record().moves.length === 2) records.push(service.record()); });
    await port.commit(black, '合法挺卒');
    const timing = records[0].notes[0].timing!;
    expect(timing.totalMs).toBe(1300); expect(sum(timing)).toBe(1300);
    expect(timing.breakdown).toMatchObject({ modelMs: 1000, toolMs: 100, reviewMs: 200 });
    expect(timing.spans.find(s => s.id === 'commit')?.status).toBe('ok');
    expect(service.snapshot().progress).toBeUndefined();
    now = 5000; port.telemetry!({ type: 'end', id: 'commit', ok: false });
    expect(service.record().notes[0].timing).toEqual(timing);
    expect(normalizeRecord(service.record()).moves).toHaveLength(2);
    const old = service.record(); delete old.notes[0].timing;
    expect(normalizeRecord(old).moves).toHaveLength(2); service.dispose();
  });
  test('error at unchanged revision changes save key; cancel/retry ignores stale events', async () => {
    let now = 0, old!: TurnPort;
    const service = new GameService({ async run(p) {
      old = p; p.telemetry!({ type: 'start', id: 'model', kind: 'model', name: 'request-1' }); now += 50; throw new Error('network error');
    } }, model, { now: () => now });
    service.humanMove(red, 0); const before = recordSaveKey({ id: service.snapshot().id, revision: 1 });
    await Bun.sleep(5);
    expect(service.snapshot().revision).toBe(1); expect(recordSaveKey(service.snapshot())).not.toBe(before);
    expect(service.record().attempts![0]).toMatchObject({ status: 'error', timing: { totalMs: 50 } });
    expect(service.record().attempts![0].timing.spans[0].status).toBe('interrupted');
    const record = service.record(); old.telemetry!({ type: 'end', id: 'model', ok: true });
    expect(service.record().attempts).toEqual(record.attempts); service.dispose();

    const ports: TurnPort[] = [];
    const retry = new GameService({ async run(p) { ports.push(p); await new Promise(() => {}); } }, model, { now: () => now });
    retry.humanMove(red, 0); ports[0].telemetry!({ type: 'start', id: 'm', kind: 'model', name: 'request-1' });
    now += 300; retry.cancel(); const cancelled = retry.record().attempts![0];
    expect(cancelled.status).toBe('cancelled'); expect(cancelled.timing.totalMs).toBe(300);
    retry.retry(); const progress = retry.snapshot().progress;
    ports[0].telemetry!({ type: 'start', id: 'stale', kind: 'tool', name: 'move_piece' });
    expect(retry.snapshot().progress).toEqual(progress);
    now += 100; retry.tick(); expect(retry.snapshot().progress?.elapsedMs).toBe(100);
    retry.dispose(); expect(retry.record().attempts).toHaveLength(2);
  });
  test('timeout and replacement finalize once, bound history, and keep original game saved', () => {
    let now = 0; const ports: TurnPort[] = [];
    const service = new GameService({ async run(p) { ports.push(p); await new Promise(() => {}); } }, model,
      { now: () => now, settings: { ...DEFAULT_SETTINGS, mainTimeMs: 1000 } });
    service.humanMove(red, 0); now = 1000; service.tick();
    expect(service.record().attempts?.map(a => a.status)).toEqual(['timeout']);
    service.tick(); expect(service.record().attempts).toHaveLength(1);
    const saved: ReturnType<GameService['record']>[] = []; service.subscribe(() => saved.push(service.record()));
    service.newGame(2); const id = service.snapshot().id;
    service.newGame(1); expect(saved.some(r => r.id === id && r.attempts?.at(-1)?.status === 'superseded')).toBe(true);
    service.humanMove(red, service.snapshot().revision);
    for (let i = 0; i < 82; i++) { service.cancel(); service.retry(); }
    service.cancel(); expect(service.record().attempts).toHaveLength(80);
    expect(service.view().attempts).toHaveLength(1); service.dispose();
  });
});
