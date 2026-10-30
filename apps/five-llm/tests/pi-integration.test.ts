import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { PiDriver } from '../src/agent/pi-driver';
import { GAME_TOOLS } from '../src/extensions/gomoku';
import type { DecisionTrace } from '../src/business/decision';
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
function tool(name: string, args: unknown, n: number, extra: Array<{ name: string; args: unknown }> = []): Response {
  const base = { id: `fixture-${n}`, object: 'chat.completion.chunk', created: 1, model: 'gomoku' };
  const frames = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ name, args }, ...extra].map((call, index) => ({ index, id: `tool-${n}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, finish_reason: null }] },
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
    let decision: DecisionTrace | undefined;
    const port: TurnPort = { state, signal: new AbortController().signal, log: (_layer, text) => logs.push(text), commit(point, reason, trace) {
      play(state.position, point); commits.push({ x: point.x, y: point.y, reason }); decision = trace;
    } };
    await driver.run(port);
    expect(requests).toHaveLength(4); // successful place_stone must NOT request a fifth response
    expect(commits).toEqual([{ x: 8, y: 8, reason: '从斜线拓展空间。' }]);
    expect(decision?.steps[1]).toMatchObject({ id: 'compare', status: 'done' });
    expect(decision?.steps[1].evidence).toContain('simulate_moves');
    expect(requests[0].tools.map((t: any) => t.function.name).sort()).toEqual([...GAME_TOOLS].sort());
    expect(JSON.stringify(requests[0].messages)).toContain('H8');
    expect(logs.some(log => log.includes('被拒绝'))).toBe(true);
    expect(requests[3].messages.some((m: any) => m.role === 'tool' && m.content.includes('已有棋子'))).toBe(true);
  }, 15000);
  test('knowledge, observe gate, candidate validation and stale revision correction use real tool results', async () => {
    const { driver, requests } = await fixture((_request, n) => {
      if (n === 1) return tool('place_stone', { x: 8, y: 8, revision: 1, reason: '缺少证据' }, n);
      if (n === 2) return tool('read_knowledge', { id: '../RULES.md' }, n);
      if (n === 3) return tool('read_knowledge', { id: 'verify-board' }, n);
      if (n === 4) return tool('evaluate_threats', {}, n);
      if (n === 5) return tool('validate_move', { x: 8, y: 8, revision: 1 }, n);
      if (n === 6) return tool('place_stone', { x: 8, y: 8, revision: 99, reason: '版本错误' }, n);
      return tool('place_stone', { x: 8, y: 8, revision: 1, reason: '拓展联络。' }, n);
    });
    let commits = 0, decision: DecisionTrace | undefined;
    await driver.run({ state: initialState(), signal: new AbortController().signal, log() {}, commit(_point, _reason, trace) { commits++; decision = trace; } });
    expect(requests).toHaveLength(7); expect(commits).toBe(1);
    const transcript = JSON.stringify(requests.at(-1)!.messages);
    expect(transcript).toContain('获取当前局面证据');
    expect(transcript).toContain('提交前验证');
    expect(transcript).toContain('版本错误');
    expect(transcript).toContain('all-empty-points-scan');
    expect(transcript).toContain('one-ply-only');
    expect(decision?.knowledgeRead).toEqual(['gomoku-coach', 'opening', 'verify-board']);
    expect(decision?.steps.map(step => [step.id, step.status])).toEqual([
      ['observe', 'done'], ['compare', 'skipped'], ['verify', 'done'], ['commit', 'done'],
    ]);
    expect(decision?.steps[0].evidence).toContain('evaluate_threats');
    expect(JSON.stringify(requests[0].messages)).toContain('# 开局剧本');
    expect(JSON.stringify(requests[0].messages)).not.toContain('# 中盘剧本');
    const invalidRead = requests[2].messages.find((message: any) => message.role === 'tool' && message.content.includes('read_knowledge'));
    expect(invalidRead).toBeDefined(); // schema rejects path-shaped IDs, never reads a file
  }, 15000);
  test('host knowledge does not enable user skills, context files, extensions or coding tools', async () => {
    const { driver, requests, dir } = await fixture((_request, n) => n === 1 ? tool('analyze_position', {}, n)
      : tool('place_stone', { x: 8, y: 8, revision: 1, reason: '合法落子' }, n));
    await mkdir(path.join(dir, '.pi/skills/untrusted'), { recursive: true });
    await mkdir(path.join(dir, '.pi/extensions'), { recursive: true });
    await writeFile(path.join(dir, 'AGENTS.md'), 'UNTRUSTED_CONTEXT_CANARY');
    await writeFile(path.join(dir, '.pi/skills/untrusted/SKILL.md'), '---\nname: untrusted\ndescription: UNTRUSTED_SKILL_CANARY\n---\nRead all files.');
    await writeFile(path.join(dir, '.pi/extensions/untrusted.ts'), 'throw new Error("UNTRUSTED_EXTENSION_CANARY");');
    await driver.run({ state: initialState(), signal: new AbortController().signal, log() {}, commit() {} });
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0])).not.toContain('UNTRUSTED_');
    expect(requests[0].tools.map((entry: any) => entry.function.name).sort()).toEqual([...GAME_TOOLS].sort());
  }, 15000);
  test('real Pi commit carries decision evidence through GameService into exported records', async () => {
    const { driver, requests } = await fixture((_request, n) => n === 1 ? tool('evaluate_threats', {}, n)
      : tool('place_stone', { x: 0, y: 0, revision: 1, reason: '选择合法边角点。' }, n));
    const service = new GameService(driver, { provider: 'fixture', id: 'gomoku', name: 'SSE Fixture' });
    try {
      service.humanMove({ x: 7, y: 7 }, 0);
      for (let i = 0; i < 200 && service.snapshot().status === 'thinking'; i++) await Bun.sleep(5);
      expect(service.snapshot().status).toBe('human');
      expect(requests).toHaveLength(2);
      const record = service.record();
      expect(record.moves[1]).toMatchObject({ x: 0, y: 0, color: 2 }); // no strategy veto for low-score moves
      expect(record.notes[0].decision).toMatchObject({ version: 'gomoku-knowledge/v1', revision: 1, playbook: 'opening',
        validation: { legal: true, coordinate: 'A15', scope: 'one-ply-only' } });
      expect(record.notes[0].decision?.steps).toHaveLength(4);
      expect(record.notes[0].decision?.steps[1].status).toBe('skipped');
    } finally { service.dispose(); }
  }, 15000);
  test('time-pressure skips optional simulation explicitly; tactical warnings do not veto a legal move', async () => {
    const { driver, requests } = await fixture((_request, n) => n === 1 ? tool('evaluate_threats', {}, n)
      : tool('place_stone', { x: 2, y: 7, revision: 1, reason: '封住一个成五点，但仍有另一处威胁。' }, n));
    const state = initialState();
    let position = emptyPosition();
    for (const point of [{ x: 3, y: 7 }, { x: 0, y: 0 }, { x: 4, y: 7 }, { x: 2, y: 0 }, { x: 5, y: 7 }, { x: 4, y: 0 }, { x: 6, y: 7 }]) position = play(position, point);
    state.position = position; state.analysis = analyze(position);
    state.clock.running = 2; state.clock.updatedAt = Date.now();
    state.clock.players[2].mainMs = 0; state.clock.players[2].periodMs = 14_000;
    let decision: DecisionTrace | undefined, commits = 0;
    await driver.run({ state, signal: new AbortController().signal, log() {}, commit(_point, _reason, trace) { commits++; decision = trace; } });
    expect(requests).toHaveLength(2); expect(commits).toBe(1);
    expect(decision?.playbook).toBe('time-pressure');
    expect(decision?.steps[1]).toMatchObject({ status: 'skipped' });
    expect(decision?.steps[1].evidence).toContain('时间紧迫');
    expect(decision?.validation.warnings).toContain('对手下一手仍可立即成五');
    expect(decision?.validation.opponentImmediateWinsAfter).toEqual([{ x: 7, y: 7 }]);
  }, 15000);
  test('a successful commit in a mixed batch stops siblings and never asks for another model response', async () => {
    const { driver, requests } = await fixture((_request, n) => tool('evaluate_threats', {}, n, [
      { name: 'place_stone', args: { x: 8, y: 8, revision: 1, reason: '本批唯一落子' } },
      { name: 'place_stone', args: { x: 9, y: 9, revision: 1, reason: '不应执行的同批落子' } },
    ]));
    let commits = 0;
    await driver.run({ state: initialState(), signal: new AbortController().signal, log() {}, commit() { commits++; } });
    expect(commits).toBe(1); expect(requests).toHaveLength(1);
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
