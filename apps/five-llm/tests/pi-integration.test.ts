import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { PiDriver } from '../src/agent/pi-driver';
import { analyze, play, emptyPosition } from '../src/business/engine';
import { GameService, type TurnPort } from '../src/business/game-service';
import type { GameState } from '../src/shared/types';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function initialState(): GameState {
  const position = play(emptyPosition(), { x: 7, y: 7 });
  const base = new GameService({ async run() {} }).snapshot();
  return { ...base, id: 'integration', revision: 1, human: 1, position, analysis: analyze(position), evaluations: [analyze(position)], notes: [],
    status: 'thinking', error: null, logs: [], model: { provider: 'fixture', id: 'gomoku', name: 'SSE Fixture' } };
}
async function fixture(responder: (request: Record<string, any>, n: number) => Response | Promise<Response>) {
  const requests: Array<Record<string, any>> = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const body = await request.json() as Record<string, any>; requests.push(body); return responder(body, requests.length);
  } });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'five-pi-test-'));
  cleanups.push(() => { server.stop(true); }); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const modelsPath = path.join(dir, 'models.json');
  await writeFile(modelsPath, JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', apiKey: 'test-only',
    models: [{ id: 'gomoku', name: 'SSE Fixture', contextWindow: 65536, maxTokens: 1024 }],
  } } }));
  const runtime = await ModelRuntime.create({ authPath: path.join(dir, 'auth.json'), modelsPath, modelsStorePath: path.join(dir, 'catalog.json') });
  return { driver: new PiDriver(runtime, dir, 5000), runtime, dir, requests };
}
function tool(name: string, args: unknown, n: number): Response {
  const base = { id: `fixture-${n}`, object: 'chat.completion.chunk', created: 1, model: 'gomoku' };
  const frames = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `tool-${n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } },
  ];
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}
describe('real Pi harness + inline gomoku extension, local SSE transport', () => {
  test('only game tools, analysis, simulation, illegal-move correction and terminal commit', async () => {
    const { driver, requests } = await fixture((_request, n) => {
      if (n === 1) return tool('analyze_position', {}, n);
      if (n === 2) return tool('simulate_moves', { moves: [{ x: 8, y: 8 }, { x: 6, y: 6 }] }, n);
      if (n === 3) return tool('place_stone', { x: 7, y: 7, revision: 1, reason: '非法占用点' }, n);
      return tool('place_stone', { x: 8, y: 8, revision: 1, reason: '从斜线拓展空间。' }, n);
    });
    const state = initialState(), commits: any[] = [], logs: string[] = [];
    const port: TurnPort = { state, signal: new AbortController().signal, log: (_layer, text) => logs.push(text), commit(point, reason) {
      play(state.position, point); commits.push({ x: point.x, y: point.y, reason });
    } };
    await driver.run(port);
    expect(requests).toHaveLength(4); // successful place_stone must NOT request a fifth response
    expect(commits).toEqual([{ x: 8, y: 8, reason: '从斜线拓展空间。' }]);
    expect(requests[0].tools.map((t: any) => t.function.name).sort()).toEqual(['analyze_position', 'place_stone', 'simulate_moves']);
    expect(JSON.stringify(requests[0].messages)).toContain('H8');
    expect(logs.some(log => log.includes('被拒绝'))).toBe(true);
    expect(requests[3].messages.some((m: any) => m.role === 'tool' && m.content.includes('已有棋子'))).toBe(true);
  }, 15000);
  test('request budget stops a model that endlessly requests analysis', async () => {
    const { driver, requests } = await fixture((_request, n) => tool('analyze_position', {}, n));
    let commits = 0;
    await expect(driver.run({ state: initialState(), signal: new AbortController().signal, log() {}, commit() { commits++; } })).rejects.toThrow('上限');
    expect(requests.length).toBeLessThanOrEqual(8); expect(commits).toBe(0);
  }, 10000);
  test('timeout aborts slow transport without a commit', async () => {
    const { runtime, dir } = await fixture(async () => { await Bun.sleep(300); return tool('place_stone', { x: 8, y: 8, revision: 1, reason: '迟到' }, 1); });
    let commits = 0;
    await expect(new PiDriver(runtime, dir, 70).run({ state: initialState(), signal: new AbortController().signal, log() {}, commit() { commits++; } })).rejects.toThrow('超时');
    expect(commits).toBe(0);
  }, 10000);
  test('abort interrupts pending network work without a commit', async () => {
    const { driver } = await fixture(async () => { await Bun.sleep(300); return tool('place_stone', { x: 8, y: 8, revision: 1, reason: '不应落子' }, 1); });
    const controller = new AbortController(); let commits = 0;
    const run = driver.run({ state: initialState(), signal: controller.signal, log() {}, commit() { commits++; } });
    setTimeout(() => controller.abort(), 100);
    await expect(run).rejects.toThrow(); expect(commits).toBe(0);
  }, 10000);
});
