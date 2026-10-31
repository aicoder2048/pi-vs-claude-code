import { afterEach, describe, expect, spyOn, test } from 'bun:test';
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
import { searchPosition, type SearchOptions } from '../src/business/search';
import { updatePlan } from '../src/business/plan';
import { DEFAULT_SETTINGS } from '../src/business/clock';
import { RECORDED_GAME } from './fixtures/recorded-game';
import type { GameState } from '../src/shared/types';
import { EXPECTED_SKILLS, DEFAULT_SKILLS_DIR } from '../src/agent/skill-loader';

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
  return { driver: new PiDriver(runtime, dir), runtime, dir, requests };
}
function tool(name: string, args: unknown, n: number): Response { return toolCalls([{ name, args }], n); }
function toolCalls(calls: { name: string; args: unknown }[], n: number): Response {
  const base = { id: `fixture-${n}`, object: 'chat.completion.chunk', created: 1, model: 'xiangqi' };
  const frames = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: calls.map(({ name, args }, index) => ({ index, id: `tool-${n}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }, finish_reason: null }] },
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
    expect(requests[0].messages[0].content).toContain('<available_skills>');
    expect(requests[0].messages[0].content).toContain('象棋决策编排');
    expect(requests[0].tools.map((t: any) => t.function.name).sort()).toEqual([...XIANGQI_TOOLS].sort());
    expect(JSON.stringify(requests[0].messages)).toContain('A6 → A5');
    expect(logs.some(log => log.includes('被拒绝'))).toBe(true);
    expect(JSON.stringify(requests[0].messages)).toContain('expert');
    expect(JSON.stringify(requests[0].messages)).toContain('knowledge');
    expect(JSON.stringify(requests[0].messages)).toContain('source');
    expect(requests[5].messages.some((m: any) => m.role === 'tool' && m.content.includes('自己的棋子'))).toBe(true);
  }, 15000);
  test('resign_game rejects stale revision, then ends real Pi/service turn without a move or follow-up', async () => {
    let service!: GameService, run!: Promise<void>;
    const { driver, requests } = await fixture((_request, n) => tool('resign_game', {
      revision: n === 1 ? 0 : 1, reason: '当前无已验证解围手段，主动认输。',
    }, n));
    service = new GameService({ run(port) { run = driver.run(port); return run; } }, { provider: 'fixture', id: 'xiangqi', name: 'fixture' },
      { now: () => 0, search: { async search(p) { return searchPosition(p, { maxMs: 0, maxNodes: 0 }); } } });
    cleanups.push(() => service.dispose());
    service.humanMove({ from: { x: 0, y: 6 }, to: { x: 0, y: 5 } }, 0); await run;
    expect(requests).toHaveLength(2); expect(service.record().moves).toHaveLength(1);
    expect(requests[1].messages.some((m: any) => m.role === 'tool' && m.content.includes('版本错误'))).toBe(true);
    expect(service.snapshot().outcome).toMatchObject({ winner: 1, reason: 'resign' });
    expect(service.snapshot().error).toBeNull(); expect(service.record().notes).toHaveLength(0);
    expect(service.record().resignation?.decision?.tools).toEqual([{ name: 'resign_game', ok: false }, { name: 'resign_game', ok: true }]);
    expect(service.record().resignation?.timing?.spans.filter(s => s.name === 'resign_game').map(s => s.status)).toEqual(['error', 'ok']);
    expect(JSON.stringify(requests[0].messages)).toContain('不要用无补偿送子');
  }, 15000);
  test('successful resign_game blocks a sibling move in the same model batch', async () => {
    const { driver, requests } = await fixture((_request, n) => toolCalls([
      { name: 'resign_game', args: { revision: 1, reason: '主动结束对局。' } },
      { name: 'move_piece', args: { from: { x: 0, y: 3 }, to: { x: 0, y: 4 }, revision: 1, reason: '认输后不能再动。' } },
    ], n));
    let resignations = 0, commits = 0;
    await driver.run({ state: initialState(), signal: new AbortController().signal, log() {},
      resign() { resignations++; }, commit() { commits++; } });
    expect(resignations).toBe(1); expect(commits).toBe(0); expect(requests).toHaveLength(1);
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
    const error = requests[1].messages.find((m: any) => m.role === 'tool').content;
    expect(error).toContain('playbook-risk-acknowledgement');
    expect(error).not.toContain('checkedReplies'); expect(error).not.toContain('positionalDelta');
    expect(error.length).toBeLessThan(1500);
  }, 15000);
  test('real loop sees automatic search, calls bounded search, stages a plan and awaits async commit', async () => {
    const next = { from: { x: 0, y: 3 }, to: { x: 0, y: 4 } };
    const plan = { action: 'revise' as const, reason: '比较后优先疏通车路。', objective: '协调车炮', problem: '部分子力尚未出动',
      opponentThreat: '对手准备推进边兵', nextSteps: ['先查直接威胁', '择机疏通车路'], abandonWhen: '出现直接杀棋时放弃原路线' };
    const { driver, requests } = await fixture((_request, n) => {
      if (n === 1) return tool('analyze_position', {}, n);
      if (n === 2) return tool('search_position', { moves: [next], maxDepth: 4, maxMs: 100 }, n);
      if (n === 3) return tool('update_plan', plan, n);
      return tool('move_piece', { ...next, revision: 1, reason: '先协调兵力，不盲目进攻。' }, n);
    });
    const state = initialState(), searches: SearchOptions[] = []; let committed = false;
    await driver.run({ state, signal: new AbortController().signal, log() {},
      async search(options = {}) {
        searches.push(options); const report = searchPosition(state.position, { ...options, maxMs: 0, maxNodes: 0 });
        state.analysis.expert!.search = report; return report;
      },
      updatePlan(input) { state.plan = updatePlan(state.position, state.plan, input); return state.plan; },
      async commit(move) { await Bun.sleep(20); play(state.position, move); committed = true; },
    });
    expect(committed).toBe(true); expect(requests).toHaveLength(4); expect(searches).toHaveLength(2);
    expect(searches[0]).toEqual({}); expect(searches[1].moves).toEqual([next]); expect(state.plan?.objective).toBe('协调车炮');
    expect(JSON.stringify(requests[0].messages)).toContain('completedDepth');
    expect(requests[2].messages.some((m: any) => m.role === 'tool' && m.content.includes('requested-subset'))).toBe(true);
    expect(requests[3].messages.some((m: any) => m.role === 'tool' && m.content.includes('staged'))).toBe(true);
  }, 15000);
  test('reads enum skills and references; rejected reads and failed commits stay in ordered persisted audit', async () => {
    let service!: GameService, run!: Promise<void>;
    const { driver, requests } = await fixture((_request, n) => {
      if (n === 1) return tool('read_skill', { name: 'playbook-endgame' }, n);
      if (n === 2) return tool('read_skill', { name: 'read-expert-report', reference: '../SKILL.md' }, n);
      if (n === 3) return tool('read_skill', { name: 'foreign' }, n);
      if (n === 4) return tool('read_skill', { name: 'read-expert-report', reference: 'principles.md' }, n);
      if (n === 5) return tool('move_piece', { from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, revision: 1, reason: '非法示例' }, n);
      return tool('move_piece', { from: { x: 0, y: 3 }, to: { x: 0, y: 4 }, revision: 1, reason: '修正后安全挺卒。' }, n);
    });
    service = new GameService({ run(port) { run = driver.run(port); return run; } }, { provider: 'fixture', id: 'xiangqi', name: 'fixture' },
      { now: () => 0, search: { async search(p) { return searchPosition(p, { maxMs: 0, maxNodes: 0 }); } } });
    cleanups.push(() => service.dispose());
    const saved: any[] = [];
    service.subscribe(() => { if (service.record().moves.length === 2) saved.push(service.record()); });
    service.humanMove({ from: { x: 0, y: 6 }, to: { x: 0, y: 5 } }, 0); await run;
    const timing = saved[0].notes[0].timing as import('../src/business/turn-timing').TurnTiming;
    expect(timing.version).toBe('xiangqi-timing/v1');
    expect(timing.spans.filter(s => s.kind === 'model')).toHaveLength(6);
    expect(timing.spans.filter(s => s.kind === 'tool')).toHaveLength(6);
    expect(timing.spans.some(s => s.kind === 'pre-search')).toBe(true);
    expect(timing.spans.some(s => s.kind === 'review')).toBe(true);
    expect(timing.spans.some(s => s.status === 'running')).toBe(false);
    expect(timing.spans.filter(s => s.kind === 'model').every(s => s.firstDeltaMs !== undefined)).toBe(true);
    expect(Object.values(timing.breakdown).reduce((a, b) => a + b, 0)).toBeCloseTo(timing.totalMs, 4);
    expect(JSON.stringify(timing)).not.toContain('非法示例');
    const trace = saved[0].notes[0].decision;
    expect(trace.version).toBe('xiangqi-skills/v2'); expect(trace.revision).toBe(1);
    expect(trace.skillsInjected).toEqual(['xiangqi-coach', trace.playbook]);
    expect(trace.skillsRead).toEqual(['playbook-endgame', 'read-expert-report/principles.md']);
    expect(trace.tools).toEqual([
      { name: 'read_skill', ok: true }, { name: 'read_skill', ok: false }, { name: 'read_skill', ok: false },
      { name: 'read_skill', ok: true }, { name: 'move_piece', ok: false }, { name: 'move_piece', ok: true },
    ]);
    expect(trace.steps.find((s: any) => s.id === 'plan').status).toBe('skipped');
    expect(trace.steps.find((s: any) => s.id === 'commit').status).toBe('done');
    const system = requests[0].messages[0].content as string;
    expect(system.match(/## 当前剧本：/g)).toHaveLength(1);
    expect(system).not.toContain('# 残局'); expect(system).not.toContain(DEFAULT_SKILLS_DIR);
    expect(requests[1].messages.some((m: any) => m.role === 'tool' && m.content.includes('# 残局'))).toBe(true);
    const schema = requests[0].tools.find((t: any) => t.function.name === 'read_skill').function.parameters;
    expect(schema.properties.name.anyOf.map((s: any) => s.const).sort()).toEqual([...EXPECTED_SKILLS].sort());
    expect(service.record().format).toBe('chinese-chess/v1');
  }, 15000);
  test('missing bundle fails explicitly before network; terminal position makes no request', async () => {
    const { runtime, dir, requests } = await fixture((_request, n) => tool('analyze_position', {}, n));
    const state = initialState(); let committed = false;
    const port: TurnPort = { state, signal: new AbortController().signal, log() {}, commit() { committed = true; } };
    await expect(new PiDriver(runtime, dir, path.join(dir, 'missing')).run(port)).rejects.toThrow();
    expect(requests).toHaveLength(0); expect(committed).toBe(false);
    state.position.winner = 'draw'; await new PiDriver(runtime, dir).run(port);
    expect(requests).toHaveLength(0);
  }, 10000);
  test('skill reads consume the shared 16-call budget even within a single assistant batch', async () => {
    const { driver, requests } = await fixture((_request, n) => n === 1 ?
      toolCalls(Array.from({ length: 17 }, () => ({ name: 'read_skill', args: { name: 'coordinates' } })), n) :
      new Response(`data: ${JSON.stringify({ id: 'finished', object: 'chat.completion.chunk', created: 1, model: 'xiangqi',
        choices: [{ index: 0, delta: { role: 'assistant', content: '预算已耗尽，未落子。' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } }));
    let trace: import('../src/business/decision').DecisionTrace | undefined, commits = 0;
    await driver.run({ state: initialState(), signal: new AbortController().signal, log() {},
      setDecision(value) { trace = structuredClone(value); }, commit() { commits++; } });
    expect(commits).toBe(0); expect(trace!.skillsRead).toHaveLength(16);
    expect(trace!.tools).toHaveLength(17); expect(trace!.tools.at(-1)?.ok).toBe(false);
    expect(requests[1].messages.some((m: any) => m.role === 'tool' && m.content.includes('预算已耗尽'))).toBe(true);
  }, 10000);
  test('analysis budget exhaustion does not remove the resignation exit', async () => {
    const { driver, requests } = await fixture((_request, n) => n === 1 ?
      toolCalls(Array.from({ length: 17 }, () => ({ name: 'read_skill', args: { name: 'coordinates' } })), n) :
      tool('resign_game', { revision: 1, reason: '主动认输，不用等待超时。' }, n));
    let resignations = 0;
    await driver.run({ state: initialState(), signal: new AbortController().signal, log() {},
      resign() { resignations++; }, commit() { throw new Error('不应落子'); } });
    expect(resignations).toBe(1); expect(requests).toHaveLength(2);
    expect(requests[1].messages.some((m: any) => m.role === 'tool' && m.content.includes('预算已耗尽'))).toBe(true);
  }, 10000);
  test('request budget stops a model that endlessly requests analysis', async () => {
    const { driver, requests } = await fixture((_request, n) => tool('analyze_position', {}, n));
    let commits = 0;
    await expect(driver.run({ state: initialState(), signal: new AbortController().signal, log() {}, commit() { commits++; } })).rejects.toThrow('上限');
    expect(requests.length).toBeLessThanOrEqual(8); expect(commits).toBe(0);
  }, 10000);
  test('slow transport has no application 90-second deadline and may finish while its clock is live', async () => {
    const { driver, requests } = await fixture(async (_request, n) => { await Bun.sleep(150); return tool('move_piece', { from: { x: 0, y: 3 }, to: { x: 0, y: 4 }, revision: 1, reason: '仍有余时，合法完成落子。' }, n); });
    let commits = 0;
    // Inspect deadline registration rather than waiting 90 real seconds.
    const timers = spyOn(globalThis, 'setTimeout');
    try {
      await driver.run({ state: initialState(), signal: new AbortController().signal, log() {}, commit() { commits++; } });
      expect(timers.mock.calls.some(([, ms]) => ms === 90000)).toBe(false);
    } finally { timers.mockRestore(); }
    expect(commits).toBe(1);
    expect(JSON.stringify(requests[0].messages)).toContain('不另设单步时间上限');
    expect(JSON.stringify(requests[0].messages)).toContain('包干制，不加秒');
    expect(JSON.stringify(requests[0].messages)).toContain('1800 秒');
  }, 10000);
  test('game cancellation signal reaches an already-running async move tool', async () => {
    const { driver } = await fixture((_request, n) => tool('move_piece', { from: { x: 0, y: 3 }, to: { x: 0, y: 4 }, revision: 1, reason: '等待独立搜索复查。' }, n));
    const controller = new AbortController(); let committed = false, toolSignal: AbortSignal | undefined;
    await expect(driver.run({ state: initialState(), signal: controller.signal, log() {},
      async commit(_move, _reason, _ack, signal) {
        toolSignal = signal; controller.abort(); await Bun.sleep(20);
        if (signal?.aborted) throw new Error('工具已取消，拒绝迟到落子');
        committed = true;
      },
    })).rejects.toThrow('取消');
    expect(toolSignal).toBeDefined(); expect(toolSignal!.aborted).toBe(true); expect(committed).toBe(false);
  }, 10000);
  test('real Pi service turn can spend more than 90 seconds of its remaining game clock', async () => {
    let now = 0, service!: GameService, run!: Promise<void>;
    const { driver } = await fixture((_request, n) => {
      now = 120000; service.tick();
      return tool('move_piece', { from: { x: 0, y: 3 }, to: { x: 0, y: 4 }, revision: 1, reason: '长考后按余时及时落子。' }, n);
    });
    service = new GameService({ run(port) { run = driver.run(port); return run; } }, { provider: 'fixture', id: 'xiangqi', name: 'SSE Fixture' },
      { now: () => now, search: { async search(p) { return searchPosition(p, { maxMs: 0, maxNodes: 0 }); } } });
    cleanups.push(() => service.dispose());
    service.humanMove({ from: { x: 0, y: 6 }, to: { x: 0, y: 5 } }, 0); await run;
    expect(service.snapshot().outcome).toBeNull(); expect(service.snapshot().position.moves).toHaveLength(2);
    expect(service.snapshot().notes[0].elapsedMs).toBe(120000);
    expect(service.record().notes[0].timing!.breakdown.modelMs).toBe(120000);
    expect(service.snapshot().clock.players[2].mainMs).toBe(DEFAULT_SETTINGS.mainTimeMs - 120000);
  }, 10000);
  test('remaining game clock aborts real Pi network work and prevents a late increment or move', async () => {
    let now = 0, service!: GameService, run!: Promise<void>, signal!: AbortSignal;
    const { driver } = await fixture((_request, n) => {
      now = DEFAULT_SETTINGS.mainTimeMs; service.tick();
      return tool('move_piece', { from: { x: 0, y: 3 }, to: { x: 0, y: 4 }, revision: 1, reason: '迟到响应不能补救超时。' }, n);
    });
    service = new GameService({ run(port) { signal = port.signal; run = driver.run(port); return run; } }, { provider: 'fixture', id: 'xiangqi', name: 'SSE Fixture' },
      { now: () => now, search: { async search(p) { return searchPosition(p, { maxMs: 0, maxNodes: 0 }); } } });
    cleanups.push(() => service.dispose());
    service.humanMove({ from: { x: 0, y: 6 }, to: { x: 0, y: 5 } }, 0); await expect(run).rejects.toThrow();
    expect(signal.aborted).toBe(true); expect(service.snapshot().outcome).toMatchObject({ winner: 1, reason: 'main-time' });
    expect(service.snapshot().notes).toHaveLength(0); expect(service.snapshot().position.moves).toHaveLength(1);
    expect(service.record().attempts?.at(-1)?.status).toBe('timeout');
    expect(service.record().attempts?.at(-1)?.timing.spans.some(s => s.kind === 'model' && s.status === 'interrupted')).toBe(true);
    expect(service.snapshot().clock.players[2].mainMs).toBe(0);
  }, 10000);
  test('abort interrupts pending network work without a commit', async () => {
    const { driver } = await fixture(async () => { await Bun.sleep(300); return tool('move_piece', { from: { x: 0, y: 3 }, to: { x: 0, y: 4 }, revision: 1, reason: '不应落子' }, 1); });
    const controller = new AbortController(); let commits = 0;
    const run = driver.run({ state: initialState(), signal: controller.signal, log() {}, commit() { commits++; } });
    setTimeout(() => controller.abort(), 100);
    await expect(run).rejects.toThrow(); expect(commits).toBe(0);
  }, 10000);
});
