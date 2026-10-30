import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { PiDriver } from '../src/agent/pi-driver';
import { play, emptyPosition, replay } from '../src/business/engine';
import { GameService, type TurnPort } from '../src/business/game-service';
import { analyzeExpert, MoveRiskError, needsRiskAcknowledgement, reviewMove } from '../src/business/expert';
import { retrieveKnowledge } from '../src/business/knowledge';
import { XIANGQI_TOOLS } from '../src/extensions/xiangqi';
import { RECORDED_GAME } from './fixtures/recorded-game';
import type { GameState } from '../src/shared/types';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function initialState(): GameState {
  const position = play(emptyPosition(), { from: { x: 0, y: 6 }, to: { x: 0, y: 5 } });
  const base = new GameService({ async run() {} }).snapshot();
  const analysis = analyzeExpert(position); analysis.expert!.knowledge = retrieveKnowledge(position, analysis.expert!);
  return { ...base, id: 'integration', revision: 1, human: 1, position, analysis, evaluations: [analysis], notes: [],
    status: 'thinking', error: null, logs: [], model: { provider: 'fixture', id: 'xiangqi', name: 'SSE Fixture' } };
}
async function fixture(responder: (request: Record<string, any>, n: number) => Response | Promise<Response>) {
  const requests: Array<Record<string, any>> = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const body = await request.json() as Record<string, any>; requests.push(body); return responder(body, requests.length);
  } });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'chess-pi-test-'));
  cleanups.push(() => { server.stop(true); }); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const modelsPath = path.join(dir, 'models.json');
  await writeFile(modelsPath, JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', apiKey: 'test-only',
    models: [{ id: 'xiangqi', name: 'SSE Fixture', contextWindow: 65536, maxTokens: 1024 }],
  } } }));
  const runtime = await ModelRuntime.create({ authPath: path.join(dir, 'auth.json'), modelsPath, modelsStorePath: path.join(dir, 'catalog.json') });
  return { driver: new PiDriver(runtime, dir, 5000), runtime, dir, requests };
}
function tool(name: string, args: unknown, n: number): Response {
  const base = { id: `fixture-${n}`, object: 'chat.completion.chunk', created: 1, model: 'xiangqi' };
  const frames = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `tool-${n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } },
  ];
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}
describe('real Pi harness + inline Xiangqi extension, local SSE transport', () => {
  test('only game tools, analysis, simulation, illegal-move correction and terminal commit', async () => {
    const { driver, requests } = await fixture((_request, n) => {
      if (n === 1) return tool('analyze_position', {}, n);
      if (n === 2) return tool('compare_moves', { moves: [{ from: { x: 0, y: 3 }, to: { x: 0, y: 4 } }, { from: { x: 1, y: 0 }, to: { x: 2, y: 2 } }] }, n);
      if (n === 3) return tool('review_move', { from: { x: 0, y: 3 }, to: { x: 0, y: 4 } }, n);
      if (n === 4) return tool('simulate_moves', { moves: [{ from: { x: 0, y: 3 }, to: { x: 0, y: 4 } }, { from: { x: 2, y: 6 }, to: { x: 2, y: 5 } }] }, n);
      if (n === 5) return tool('move_piece', { from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, revision: 1, reason: '非法吃自己的子' }, n);
      return tool('move_piece', { from: { x: 0, y: 3 }, to: { x: 0, y: 4 }, revision: 1, reason: '挺卒争夺河界。' }, n);
    });
    const state = initialState(), commits: any[] = [], logs: string[] = [];
    const port: TurnPort = { state, signal: new AbortController().signal, log: (_layer, text) => logs.push(text), commit(point, reason) {
      play(state.position, point); commits.push({ from: point.from, to: point.to, reason });
    } };
    await driver.run(port);
    expect(requests).toHaveLength(6); // successful move_piece must NOT request another response
    expect(commits).toEqual([{ from: { x: 0, y: 3 }, to: { x: 0, y: 4 }, reason: '挺卒争夺河界。' }]);
    expect(requests[0].tools.map((t: any) => t.function.name).sort()).toEqual([...XIANGQI_TOOLS].sort());
    expect(JSON.stringify(requests[0].messages)).toContain('A6 → A5');
    expect(logs.some(log => log.includes('被拒绝'))).toBe(true);
    expect(JSON.stringify(requests[0].messages)).toContain('expert');
    expect(JSON.stringify(requests[0].messages)).toContain('knowledge');
    expect(JSON.stringify(requests[0].messages)).toContain('source');
    expect(requests[5].messages.some((m: any) => m.role === 'tool' && m.content.includes('自己的棋子'))).toBe(true);
  }, 15000);
  test('real tool loop receives the free-rook counterexample and corrects it', async () => {
    const safer = { from: { x: 3, y: 6 }, to: { x: 2, y: 6 } };
    const { driver, requests } = await fixture((_request, n) => tool('move_piece', { ...(n === 1 ? RECORDED_GAME[41] : safer), revision: 41, reason: n === 1 ? '平车捉车' : '先保住受攻击的炮。' }, n));
    const position = replay(RECORDED_GAME.slice(0, 41)), base = initialState();
    const state = { ...base, revision: 41, position, analysis: analyzeExpert(position) };
    const commits: any[] = [];
    await driver.run({ state, signal: new AbortController().signal, log() {}, commit(move, reason, ack) {
      const report = reviewMove(position, move);
      if (needsRiskAcknowledgement(report) && !ack) throw new MoveRiskError(report);
      commits.push({ move, reason });
    } });
    expect(requests).toHaveLength(2); expect(commits).toEqual([{ move: { ...safer, revision: 41, reason: '先保住受攻击的炮。' }, reason: '先保住受攻击的炮。' }]);
    expect(requests[1].messages.some((m: any) => m.role === 'tool' && m.content.includes('900') && m.content.includes('红车 B0 → B2 吃车'))).toBe(true);
  }, 15000);
  test('request budget stops a model that endlessly requests analysis', async () => {
    const { driver, requests } = await fixture((_request, n) => tool('analyze_position', {}, n));
    let commits = 0;
    await expect(driver.run({ state: initialState(), signal: new AbortController().signal, log() {}, commit() { commits++; } })).rejects.toThrow('上限');
    expect(requests.length).toBeLessThanOrEqual(8); expect(commits).toBe(0);
  }, 10000);
  test('timeout aborts slow transport without a commit', async () => {
    const { runtime, dir } = await fixture(async () => { await Bun.sleep(300); return tool('move_piece', { from: { x: 0, y: 3 }, to: { x: 0, y: 4 }, revision: 1, reason: '迟到' }, 1); });
    let commits = 0;
    await expect(new PiDriver(runtime, dir, 70).run({ state: initialState(), signal: new AbortController().signal, log() {}, commit() { commits++; } })).rejects.toThrow('超时');
    expect(commits).toBe(0);
  }, 10000);
  test('abort interrupts pending network work without a commit', async () => {
    const { driver } = await fixture(async () => { await Bun.sleep(300); return tool('move_piece', { from: { x: 0, y: 3 }, to: { x: 0, y: 4 }, revision: 1, reason: '不应落子' }, 1); });
    const controller = new AbortController(); let commits = 0;
    const run = driver.run({ state: initialState(), signal: controller.signal, log() {}, commit() { commits++; } });
    setTimeout(() => controller.abort(), 100);
    await expect(run).rejects.toThrow(); expect(commits).toBe(0);
  }, 10000);
});
