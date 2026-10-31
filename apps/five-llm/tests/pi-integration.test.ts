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
import { humanWinCase, humanWinPosition, point } from './fixtures/positions';
import { DEFAULT_SETTINGS } from '../src/business/clock';

function midgameState(): GameState {
  const state = initialState(), position = humanWinPosition();
  state.position = position; state.revision = position.moves.length; state.analysis = analyze(position);
  state.clock.running = 2; state.clock.updatedAt = Date.now();
  return state;
}

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
      expect(record.notes[0].decision).toMatchObject({ version: 'gomoku-knowledge/v2', revision: 1, playbook: 'opening',
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
  test('midgame H7 returns a refutation BEFORE commit; model can check and choose I11 instead', async () => {
    const state = midgameState(), commits: string[] = [];
    let decision: DecisionTrace | undefined;
    const { driver, requests } = await fixture((_request, n) => {
      if (n === 1) return tool('evaluate_threats', {}, n);
      if (n === 2) return tool('place_stone', { ...point('H7'), revision: 21, reason: '下一手进攻' }, n);
      if (n === 3) return tool('check_forcing_sequences', { ...point('I11'), revision: 21 }, n);
      return tool('place_stone', { ...point('I11'), revision: 21, reason: '先拆掉对手连续先手线路。' }, n);
    });
    await driver.run({ state, signal: new AbortController().signal, log() {}, commit(p, _reason, trace) { commits.push(`${p.x},${p.y}`); decision = trace; } });
    expect(requests).toHaveLength(4); expect(commits).toEqual(['8,4']);
    const feedback = JSON.stringify(requests[2].messages);
    expect(feedback).toContain('needsReview'); expect(feedback).toContain('found-forced-loss');
    expect(feedback).toContain('two-winning-points');
    expect(decision?.candidateReview?.forcingChecks.map(c => c.result.status)).toEqual(['found-forced-loss', 'not-found-within-budget']);
    expect(decision?.candidateReview?.finalCandidateCheckIds).toEqual(['forcing-2']);
    expect(decision?.candidateReview?.forcingReview).toBe('reviewed');
    expect(state.position.moves).toHaveLength(21); // checking never mutates the board
  }, 15000);
  test('explicit risk acknowledgement on a later turn permits the original legal move, no silent replacement', async () => {
    const { driver, requests } = await fixture((_request, n) => n === 1 ? tool('evaluate_threats', {}, n)
      : tool('place_stone', { ...point('H7'), revision: 21, reason: '明确保留这一合法选择。', ...(n >= 4 ? { acknowledgeRisk: true } : {}) }, n));
    let commits = 0, decision: DecisionTrace | undefined;
    await driver.run({ state: midgameState(), signal: new AbortController().signal, log() {}, commit(p, _reason, trace) {
      expect(p).toMatchObject(point('H7')); commits++; decision = trace;
    } });
    expect(requests).toHaveLength(4); expect(commits).toBe(1);
    expect(decision?.candidateReview?.forcingChecks).toHaveLength(1);
    expect(decision?.candidateReview?.forcingChecks[0]).toMatchObject({ acknowledged: true, reviewedBeforeCommit: true });
    expect(decision?.validation.warnings).toEqual([]); // one-ply check remains truthful
  }, 15000);
  test('a check and preplanned commit in the SAME batch do not count as reading the feedback', async () => {
    const { driver, requests } = await fixture((_request, n) => {
      if (n === 1) return tool('evaluate_threats', {}, n);
      if (n === 2) return tool('check_forcing_sequences', { ...point('I11'), revision: 21 }, n, [
        { name: 'place_stone', args: { ...point('I11'), revision: 21, reason: '同批预先安排' } },
      ]);
      return tool('place_stone', { ...point('I11'), revision: 21, reason: '读到结果后确认' }, n);
    });
    let commits = 0;
    await driver.run({ state: midgameState(), signal: new AbortController().signal, log() {}, commit() { commits++; } });
    expect(requests).toHaveLength(3); expect(commits).toBe(1);
    expect(JSON.stringify(requests[2].messages)).toContain('needsReview');
  }, 15000);
  test('retains every simulation branch and never attributes another candidate to the final move', async () => {
    for (const includeFinal of [false, true]) {
      const { driver, requests } = await fixture((_request, n) => {
        if (n === 1) return tool('analyze_position', {}, n);
        if (n === 2) return tool('simulate_moves', { moves: [point('A15'), point('C15')] }, n);
        if (n === 3 && includeFinal) return tool('simulate_moves', { moves: [point('I7')] }, n);
        return tool('place_stone', { ...point('I7'), revision: 1, reason: '选定当前候选' }, n);
      });
      let decision: DecisionTrace | undefined;
      await driver.run({ state: initialState(), signal: new AbortController().signal, log() {}, commit(_p, _r, trace) { decision = trace; } });
      const review = decision!.candidateReview!;
      expect(requests).toHaveLength(includeFinal ? 4 : 3);
      expect(review.simulations).toHaveLength(includeFinal ? 2 : 1);
      expect(review.simulations[0]).toMatchObject({ id: 'simulation-1', revision: 1, candidate: 'A15', moves: ['A15', 'C15'] });
      expect(review.finalCandidateSimulationIds).toEqual(includeFinal ? ['simulation-2'] : []);
      expect(review.coverage).toBe(includeFinal ? 'single-line-only' : 'not-compared');
      expect(decision!.steps[1].status).toBe(includeFinal ? 'done' : 'skipped');
    }
  }, 15000);
  test('a shallow negative re-check cannot erase a known positive refutation for the same revision/candidate', async () => {
    const { driver, requests } = await fixture((_request, n) => {
      if (n === 1) return tool('evaluate_threats', {}, n);
      if (n === 2 || n === 3) return tool('check_forcing_sequences', { ...point('H7'), revision: 21, ...(n === 3 ? { maxAttackMoves: 1 } : {}) }, n);
      return tool('place_stone', { ...point('H7'), revision: 21, reason: '明确确认已有反证', ...(n >= 5 ? { acknowledgeRisk: true } : {}) }, n);
    });
    let decision: DecisionTrace | undefined, commits = 0;
    await driver.run({ state: midgameState(), signal: new AbortController().signal, log() {}, commit(_p, _r, trace) { commits++; decision = trace; } });
    expect(requests).toHaveLength(5); expect(commits).toBe(1);
    expect(JSON.stringify(requests[4].messages)).toContain('needsReview');
    expect(decision?.candidateReview?.forcingChecks.map(c => c.result.status)).toEqual(['found-forced-loss', 'not-found-within-budget']);
    expect(decision?.candidateReview?.forcingChecks[0].acknowledged).toBe(true);
    expect(decision?.candidateReview?.coverage).toBe('bounded-refutation');
  }, 15000);
  test('invalid/stale checks create no evidence; incomplete checks require explicit confirmation and stay incomplete', async () => {
    const { driver, requests } = await fixture((_request, n) => {
      if (n === 1) return tool('check_forcing_sequences', { ...point('I11'), revision: 99 }, n);
      if (n === 2) return tool('check_forcing_sequences', { ...point('H8'), revision: 21 }, n);
      if (n === 3) return tool('evaluate_threats', {}, n);
      if (n === 4) return tool('check_forcing_sequences', { ...point('I11'), revision: 21, maxNodes: 0 }, n);
      return tool('place_stone', { ...point('I11'), revision: 21, reason: '确认预算不足，不声称安全。', ...(n >= 6 ? { acknowledgeRisk: true } : {}) }, n);
    });
    let decision: DecisionTrace | undefined;
    await driver.run({ state: midgameState(), signal: new AbortController().signal, log() {}, commit(_p, _r, trace) { decision = trace; } });
    expect(requests).toHaveLength(6);
    expect(JSON.stringify(requests[5].messages)).toContain('needsReview');
    expect(decision?.candidateReview?.forcingChecks).toHaveLength(1);
    expect(decision?.candidateReview?.forcingChecks[0]).toMatchObject({ acknowledged: true, result: { status: 'incomplete', reason: 'node-budget' } });
    expect(decision?.candidateReview?.coverage).toBe('incomplete-refutation');
    expect(decision?.steps[1].status).toBe('skipped');
  }, 15000);
  test('urgent midgame skips extra review instead of spending another model round on a known dangerous candidate', async () => {
    const state = midgameState(); state.clock.players[2].mainMs = 0; state.clock.players[2].periodMs = 14_000;
    const { driver, requests } = await fixture((_request, n) => n === 1 ? tool('evaluate_threats', {}, n)
      : tool('place_stone', { ...point('H7'), revision: 21, reason: '时间紧迫，未作连续先手审查。' }, n));
    let decision: DecisionTrace | undefined;
    await driver.run({ state, signal: new AbortController().signal, log() {}, commit(_p, _r, trace) { decision = trace; } });
    expect(requests).toHaveLength(2);
    expect(decision?.candidateReview).toMatchObject({ forcingChecks: [], forcingReview: 'skipped-time-pressure', coverage: 'not-compared' });
  }, 15000);
  test('explicit checks under clock pressure report incomplete/clock-budget rather than claiming safety', async () => {
    const state = midgameState(); state.clock.players[2].mainMs = 0; state.clock.players[2].periodMs = 14_000;
    const { driver, requests } = await fixture((_request, n) => {
      if (n === 1) return tool('evaluate_threats', {}, n);
      if (n === 2) return tool('check_forcing_sequences', { ...point('H7'), revision: 21 }, n);
      return tool('place_stone', { ...point('H7'), revision: 21, reason: '时间不足，不把未完成当安全。' }, n);
    });
    let decision: DecisionTrace | undefined;
    await driver.run({ state, signal: new AbortController().signal, log() {}, commit(_p, _r, trace) { decision = trace; } });
    expect(requests).toHaveLength(3);
    expect(decision?.candidateReview?.forcingChecks[0].result).toMatchObject({ status: 'incomplete', reason: 'clock-budget', nodes: 0 });
  }, 15000);
  test('review feedback does not pause/refund the authoritative clock; a late post-review commit still loses', async () => {
    for (const spent of [3000, 60_001]) {
      let now = Date.now();
      const { driver, requests } = await fixture((_request, n) => {
        if (n === 1) return tool('evaluate_threats', {}, n);
        if (n === 2) return tool('check_forcing_sequences', { ...point('I11'), revision: 21 }, n);
        now += spent;
        return tool('place_stone', { ...point('I11'), revision: 21, reason: '审查后的最终候选' }, n);
      });
      const service = new GameService({ async run(port) {
        const ply = port.state.position.moves.length;
        if (ply < 21) port.commit(point(humanWinCase.moves[ply]), '仅准备回归局面');
        else await driver.run(port);
      } }, { provider: 'fixture', id: 'gomoku', name: 'SSE Fixture' }, {
        now: () => now, settings: { ...DEFAULT_SETTINGS, timeControl: 'absolute', mainTimeMs: 60_000 },
      });
      try {
        for (let i = 0; i < 21; i += 2) service.humanMove(point(humanWinCase.moves[i]), service.snapshot().revision);
        for (let i = 0; i < 200 && service.snapshot().status === 'thinking'; i++) await Bun.sleep(5);
        expect(requests).toHaveLength(3);
        const record = service.record();
        if (spent < 60_000) {
          expect(record.moves).toHaveLength(22); expect(record.clock.players[2].mainMs).toBe(57_000);
          expect(record.notes.at(-1)?.decision?.candidateReview).toMatchObject({ candidate: 'I11', forcingReview: 'reviewed', coverage: 'bounded-refutation' });
        } else {
          expect(record.moves).toHaveLength(21); expect(record.outcome).toMatchObject({ winner: 1, reason: 'main-time' });
          expect(record.notes).toHaveLength(10); // rejected attempt cannot fabricate a committed decision
        }
      } finally { service.dispose(); }
    }
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
