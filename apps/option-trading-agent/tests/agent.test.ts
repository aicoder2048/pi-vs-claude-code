import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Value } from '@sinclair/typebox/value';
import optionAgent, { type ExtensionContext, type OptionExtensionAPI } from '../extensions/option-agent/index.ts';
import { loadConfig, type Config } from '../src/agent/config.ts';
import { PiDriver } from '../src/agent/driver.ts';
import { JsonlDecoder, type RpcRecord } from '../src/agent/jsonl.ts';
import { PiProcess } from '../src/agent/rpc.ts';
import { AGENT_LIMITS, parseHello, type AgentView } from '../src/business/types.ts';
import { parseMarketRequest, parseMarketResult } from '../src/business/market-data/protocol.ts';
import { MarketData, type MarketDataOptions } from '../src/business/market-data/client.ts';
import bars from './fixtures/market/daily-bars.json';
import chain from './fixtures/market/option-chain.json';
import callsBeforePuts from './fixtures/market/calls-before-puts.ts';
import contract from './fixtures/market/contract.json';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function config(mode = 'valid'): Config {
  return loadConfig(app, {
    PATH: process.env.PATH, OPTION_AGENT_PI_BIN: join(app, 'tests/fake-pi.ts'), OPTION_AGENT_FAKE_MODE: mode,
    OPTION_AGENT_REQUEST_TIMEOUT_MS: '2000', OPTION_AGENT_TIMEOUT_MS: '1000', OPTION_AGENT_SHUTDOWN_GRACE_MS: '40',
  });
}
async function using(mode: string, run: (driver: PiDriver) => Promise<void>, timeoutMs = 1000): Promise<void> {
  const c = config(mode); c.timeoutMs = timeoutMs;
  const driver = new PiDriver(c);
  try { await driver.start(); await run(driver); } finally { await driver.stop(); }
}
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!check()) { if (Date.now() > end) throw new Error('Condition timed out.'); await Bun.sleep(5); }
}
function records(text: string): RpcRecord[] {
  const result: RpcRecord[] = [];
  const decoder = new JsonlDecoder(record => result.push(record));
  decoder.push(Buffer.from(text)); decoder.end(); return result;
}

const extensionCaches: string[] = [];
afterEach(async () => { await Promise.all(extensionCaches.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function extension(options: Pick<MarketDataOptions, 'fetch'> = {}, Service: typeof MarketData = MarketData) {
  const hooks = new Map<string, Parameters<OptionExtensionAPI['on']>[1]>();
  const commands = new Map<string, Parameters<OptionExtensionAPI['registerCommand']>[1]>();
  const tools = new Map<string, Parameters<OptionExtensionAPI['registerTool']>[0]>();
  const entries: { customType: string; data: unknown }[] = [];
  let aborted = false;
  let shutdown = false;
  const ctx: ExtensionContext = { cwd: app, model: { provider: 'openai-codex', id: 'gpt-6.1-sol' },
    abort() { aborted = true; }, shutdown() { shutdown = true; } };
  const cacheDir = mkdtempSync(join(tmpdir(), 'option-extension-'));
  extensionCaches.push(cacheDir);
  const marketData = new Service({ cacheDir, getApiKey: () => 'fixture-only-token', now: () => Date.parse('2026-10-30T20:05:00.000Z'),
    fetch: options.fetch ?? (async () => { throw new Error('No market fixture route in hook tests.'); }) });
  optionAgent({ registerTool(tool) { tools.set(tool.name, tool); }, registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { hooks.set(name, handler); }, appendEntry(customType, data) { entries.push({ customType, data }); } }, { marketData });
  return { ctx, commands, tools, entries, get aborted() { return aborted; }, get shutdown() { return shutdown; },
    hook(name: string, event: RpcRecord = {}) { return hooks.get(name)?.(event, ctx); } };
}

type RegisteredTool = Parameters<OptionExtensionAPI['registerTool']>[0];
type RegisteredToolInput = Parameters<RegisteredTool['execute']>[1];
type RegisteredToolResult = Awaited<ReturnType<RegisteredTool['execute']>>;
type RegisteredMarketResult = Exclude<RegisteredToolResult['details'], { kind: 'hello' }>;
type RegisteredMarketToolCase = {
  name: RegisteredTool['name'];
  input: RegisteredToolInput;
  expected: Pick<RegisteredMarketResult, 'kind' | 'query'>;
  rows: Partial<RegisteredMarketResult['result']['rows'][number]>[];
  asOf: string;
  schemaAccepted: RegisteredToolInput[];
  invalid: { input: RegisteredToolInput; schemaAccepts: boolean }[];
};

const occ = contract.results.details.ticker;
const marketToolCases: RegisteredMarketToolCase[] = [
  {
    name: 'get_daily_bars', input: { symbol: 'nimb', days: 4 },
    expected: { kind: 'dailyBars', query: { symbol: 'NIMB', days: 4 } },
    rows: [{ close: 102 }, { close: 101, volume: 0 }, { close: 103 }, { close: 106 }],
    asOf: new Date(1793332800000).toISOString(),
    schemaAccepted: [{ symbol: 'NIMB', days: 1 }, { symbol: 'N'.repeat(16), days: 500 }],
    invalid: [
      ...[null, [], {}, { symbol: 'NIMB' }, { days: 4 }, { symbol: 1, days: 4 },
        { symbol: '', days: 4 }, { symbol: 'N'.repeat(17), days: 4 },
        { symbol: 'NIMB', days: '4' }, { symbol: 'NIMB', days: 0 }, { symbol: 'NIMB', days: 501 },
        { symbol: 'NIMB', days: 1.5 }, { symbol: 'NIMB', days: 4, apiKey: 'forged' },
      ].map(input => ({ input, schemaAccepts: false })),
      { input: { symbol: '../NIMB', days: 4 }, schemaAccepts: true },
    ],
  },
  {
    name: 'get_option_chain', input: { symbol: 'nimb', expiry: '2026-11-06', strikeRange: { min: 100, max: 105 } },
    expected: { kind: 'optionChain', query: { symbol: 'NIMB', expiry: '2026-11-06', strikeRange: { min: 100, max: 105 } } },
    rows: [{ occ, bid: 0, ask: 0.2, openInterest: 0, volume: 0 }, { occ: 'O:NIMB261106C00105000', strike: 105 }],
    asOf: new Date(1793390460000).toISOString(),
    schemaAccepted: [{ symbol: 'N'.repeat(16) }, { symbol: 'NIMB', expiry: '2026-11-06' },
      { symbol: 'NIMB', strikeRange: { min: 0, max: 105.5 } },
      { symbol: 'NIMB', side: 'put' }, { symbol: 'NIMB', side: 'call' }],
    invalid: [
      ...[null, [], {}, { symbol: 1 }, { symbol: '' }, { symbol: 'N'.repeat(17) },
        { symbol: 'NIMB', expiry: 20261106 }, { symbol: 'NIMB', expiry: '11/06/2026' },
        { symbol: 'NIMB', strikeRange: { min: -1, max: 105 } },
        { symbol: 'NIMB', strikeRange: { min: 100 } }, { symbol: 'NIMB', strikeRange: { max: 105 } },
        { symbol: 'NIMB', strikeRange: { min: 0, max: -1 } },
        { symbol: 'NIMB', strikeRange: { min: '100', max: 105 } },
        { symbol: 'NIMB', strikeRange: { min: 100, max: 105, extra: true } },
        { symbol: 'NIMB', extra: true },
        ...[null, '', 'PUT', 'CALL', 'Put', 'both', ' put', 'put ', 'put\n', 1, true, {}, [], ['put']]
          .map(side => ({ symbol: 'NIMB', side })),
      ].map(input => ({ input, schemaAccepts: false })),
      ...[{ symbol: '../NIMB' }, { symbol: 'NIMB', expiry: '2026-02-30' },
        { symbol: 'NIMB', strikeRange: { min: 105, max: 100 } },
      ].map(input => ({ input, schemaAccepts: true })),
    ],
  },
  {
    name: 'get_contract', input: { occ: occ.replace('NIMB', 'nimb') },
    expected: { kind: 'contract', query: { occ } },
    rows: [{ occ, bid: 0, ask: 0.2, iv: 0.32, openInterest: 0, volume: 0, quotedAt: '2026-10-30T20:00:00.123Z' }],
    asOf: '2026-10-30T20:00:00.123Z',
    schemaAccepted: [{ occ: 'N'.repeat(16) }, { occ: 'N'.repeat(33) }],
    invalid: [
      ...[null, [], {}, { occ: 1 }, { occ: '' }, { occ: 'N'.repeat(15) }, { occ: 'N'.repeat(34) },
        { occ, extra: true },
      ].map(input => ({ input, schemaAccepts: false })),
      ...[{ occ: 'N'.repeat(16) }, { occ: 'O:NIMB260230P00100000' }, { occ: 'O:NIMB261106P00000000' },
      ].map(input => ({ input, schemaAccepts: true })),
    ],
  },
];

const fixtureIssues = Array.from({ length: 9 }, (_, index) => `Fixture issue ${index + 1}.`);
class ManyIssuesMarketData extends MarketData {
  override async optionChain(...args: Parameters<MarketData['optionChain']>): ReturnType<MarketData['optionChain']> {
    const result = await super.optionChain(...args);
    return { ...result, status: 'partial', issues: [...result.issues, ...fixtureIssues] };
  }
}

function modelSummary(result: RegisteredToolResult): unknown {
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe('text');
  return JSON.parse(result.content[0].text);
}

describe('business boundary DTOs', () => {
  test('parses hello and Stage 0 request/result without inventing market rows', () => {
    expect(parseHello({ kind: 'hello', name: 'Ada', greeting: 'Hello, Ada!', adviceOnly: true }).greeting).toBe('Hello, Ada!');
    expect(parseMarketRequest({ requestId: 'request-1', action: 'echo', text: '中文\nnext' }).action).toBe('echo');
    expect(parseMarketResult({ requestId: 'r', status: 'error', error: 'Invalid request.' }).status).toBe('error');
    for (const value of [null, [], {}, { requestId: '../escape', action: 'echo', text: '' }, { requestId: 'r', action: 'daily-bars', text: '' }, { requestId: 'r', action: 'echo', text: 5 }]) expect(() => parseMarketRequest(value)).toThrow();
    expect(() => parseHello({ kind: 'hello', name: 'Ada', greeting: 'Wrong', adviceOnly: true })).toThrow();
    expect(() => parseMarketResult({ requestId: 'r', status: 'ok', action: 'echo', text: '', marker: 'other', stage: 0 })).toThrow();
  });
});

describe('real extension registrations and hooks', () => {
  test('factory registers hello and no-model commands before any session event', async () => {
    const fixture = extension();
    expect([...fixture.commands.keys()]).toEqual(['option-agent', 'option-market']);
    expect([...fixture.tools.keys()].sort()).toEqual(['get_contract', 'get_daily_bars', 'get_option_chain', 'hello']);
    const tool = fixture.tools.get('hello');
    if (!tool) throw new Error('Hello was not registered.');
    const result = await tool.execute('test', { name: 'Ada' }, undefined, undefined, fixture.ctx);
    expect(parseHello(result.details).greeting).toBe('Hello, Ada!');
    expect(result.content).toEqual([{ type: 'text', text: 'Hello, Ada!' }]);
    await expect(tool.execute('test', { name: '' }, undefined, undefined, fixture.ctx)).rejects.toThrow();
    const command = fixture.commands.get('option-market');
    if (!command) throw new Error('Echo was not registered.');
    await command.handler(JSON.stringify({ requestId: 'test', action: 'echo', text: 'echo' }), fixture.ctx);
    expect(parseMarketResult(fixture.entries[0].data)).toEqual({ requestId: 'test', status: 'ok', action: 'echo', text: 'echo', marker: 'option-agent', stage: 0 });
    for (const args of ['not json', '{"requestId":"bad","action":"daily-bars"}', '{"requestId":"bad","action":"echo","text":5}']) await command.handler(args, fixture.ctx);
    expect(fixture.entries.slice(1).every(entry => entry.customType === 'option-market-result/v1' && parseMarketResult(entry.data).status === 'error')).toBe(true);
    expect(parseMarketResult(fixture.entries[2].data).requestId).toBe('bad');
  });
  test.each(marketToolCases)('$name registers a read-only sequential schema and rejects direct invalid execution', async entry => {
    let fetches = 0;
    const fixture = extension({ fetch: async () => { fetches++; throw new Error('Invalid inputs must not reach the provider.'); } });
    const tool = fixture.tools.get(entry.name);
    if (!tool) throw new Error(`${entry.name} was not registered.`);
    expect(tool.executionMode).toBe('sequential');
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(tool.parameters.type).toBe('object');
    expect(tool.parameters.additionalProperties).toBe(false);
    for (const input of [entry.input, ...entry.schemaAccepted]) expect(Value.Check(tool.parameters, input)).toBe(true);
    for (const { input, schemaAccepts } of entry.invalid) {
      expect(Value.Check(tool.parameters, input)).toBe(schemaAccepts);
      await expect(tool.execute('invalid-direct', input, undefined, undefined, fixture.ctx)).rejects.toThrow();
    }
    expect(fetches).toBe(0);
  });
  test.each(marketToolCases)('$name executes the real fixture-backed MarketData service', async entry => {
    const calls: URL[] = [];
    const fixture = extension({ fetch: async input => {
      const url = new URL(input);
      expect(url.origin).toBe('https://api.polygon.io');
      calls.push(url);
      if (/^\/v2\/aggs\/ticker\/NIMB\/range\/1\/day\/\d{4}-\d{2}-\d{2}\/2026-10-30$/.test(url.pathname)) return Response.json(bars);
      if (url.pathname === '/v3/snapshot/options/NIMB') return Response.json(chain);
      if (url.pathname === `/v3/snapshot/options/NIMB/${occ}`) return Response.json(contract);
      throw new Error(`Unknown fixture route ${url.pathname}`);
    } });
    const tool = fixture.tools.get(entry.name);
    if (!tool) throw new Error(`${entry.name} was not registered.`);
    const result = await tool.execute('valid-direct', entry.input, undefined, undefined, fixture.ctx);
    expect(result.isError).toBe(false);
    expect(result.details).toMatchObject({ ...entry.expected, result: {
      status: 'ok', provider: 'massive', source: 'network', asOf: entry.asOf,
      fetchedAt: '2026-10-30T20:05:00.000Z', issues: [], rows: entry.rows,
    } });
    if (result.details.kind === 'hello') throw new Error('Market tool returned hello.');
    expect(result.details.result.rows).toHaveLength(entry.rows.length);
    expect(modelSummary(result)).toEqual({ ...entry.expected, ...result.details.result,
      totalRows: entry.rows.length, shownRows: entry.rows.length, omittedRows: 0, totalIssues: 0 });
    expect(calls).toHaveLength(1);
    if (entry.name === 'get_option_chain') {
      expect(calls[0].searchParams.get('expiration_date')).toBe('2026-11-06');
      expect(calls[0].searchParams.get('strike_price.gte')).toBe('100');
      expect(calls[0].searchParams.get('strike_price.lte')).toBe('105');
    }
  });
  test('explicit PUT chain filters before the ten-row model summary when CALLs come first', async () => {
    const calls: URL[] = [];
    const fixture = extension({ fetch: async input => {
      const url = new URL(input);
      expect(url.origin).toBe('https://api.polygon.io');
      expect(url.pathname).toBe('/v3/snapshot/options/NIMB');
      calls.push(url);
      return Response.json(callsBeforePuts);
    } });
    const tool = fixture.tools.get('get_option_chain');
    if (!tool) throw new Error('Option chain was not registered.');
    const query = { symbol: 'NIMB', expiry: '2026-11-06', strikeRange: { min: 100, max: 111 } };
    const baseline = await tool.execute('unfiltered', query, undefined, undefined, fixture.ctx);
    if (baseline.details.kind !== 'optionChain') throw new Error('Missing baseline chain.');
    const all = baseline.details.result;
    expect(all.status).toBe('ok');
    expect(all.rows).toHaveLength(24);
    expect(all.rows.slice(0, 12).every(row => row.side === 'call')).toBe(true);
    expect(all.rows.slice(12).every(row => row.side === 'put')).toBe(true);
    expect(modelSummary(baseline)).toMatchObject({ query, totalRows: 24, shownRows: 10, omittedRows: 14,
      rows: all.rows.slice(0, 10) });
    expect(all.rows.slice(0, 10).every(row => row.side === 'call')).toBe(true);
    expect(calls[0].searchParams.has('contract_type')).toBe(false);

    const input = { ...query, side: 'put' };
    const filtered = await tool.execute('explicit-put', input, undefined, undefined, fixture.ctx);
    if (filtered.details.kind !== 'optionChain') throw new Error('Missing filtered chain.');
    const puts = filtered.details.result;
    expect(puts).toMatchObject({ status: 'ok', issues: [] });
    expect(puts.rows).toHaveLength(12);
    expect(puts.rows.every(row => row.side === 'put')).toBe(true);
    expect(modelSummary(filtered)).toMatchObject({ query: input, totalRows: 12, shownRows: 10, omittedRows: 2,
      rows: puts.rows.slice(0, 10), guidance: expect.stringContaining('side') });
    expect(calls).toHaveLength(2);
    expect(calls[1].searchParams.get('contract_type')).toBe('put');
    expect(calls[1].searchParams.get('expiration_date')).toBe(query.expiry);
    expect(calls[1].searchParams.get('strike_price.gte')).toBe('100');
    expect(calls[1].searchParams.get('strike_price.lte')).toBe('111');
  });
  test.each([20, 500])('daily bars expose all %i requested bars in model content', async days => {
    const providerRows = Array.from({ length: Math.ceil(days * 7 / 5) + 2 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 9, 29, 12) - index * 86_400_000);
      return { ...bars.results[0], t: date.getTime() };
    }).filter(row => ![0, 6].includes(new Date(row.t).getUTCDay())).slice(0, days);
    let fetches = 0;
    const fixture = extension({ fetch: async input => {
      const url = new URL(input);
      expect(url.origin).toBe('https://api.polygon.io');
      expect(url.pathname).toMatch(/^\/v2\/aggs\/ticker\/NIMB\/range\/1\/day\/\d{4}-\d{2}-\d{2}\/2026-10-30$/);
      fetches++;
      return Response.json({ ...bars, resultsCount: providerRows.length, results: providerRows });
    } });
    const tool = fixture.tools.get('get_daily_bars');
    if (!tool) throw new Error('Daily bars were not registered.');
    const result = await tool.execute('full-history', { symbol: 'NIMB', days }, undefined, undefined, fixture.ctx);
    if (result.details.kind !== 'dailyBars') throw new Error('Missing daily bars details.');
    const full = result.details.result;
    expect(full.status).toBe('ok');
    expect(full.rows).toHaveLength(days);
    expect(full.rows.every(row => !row.provisional)).toBe(true);
    expect(modelSummary(result)).toMatchObject({ shownRows: days });
    expect(modelSummary(result)).toEqual({
      kind: 'dailyBars', query: { symbol: 'NIMB', days }, ...full,
      totalIssues: 0, totalRows: days, shownRows: days, omittedRows: 0,
    });
    expect(result.content[0].text).toContain(new Date(providerRows[0].t).toISOString());
    expect(result.content[0].text).toContain(new Date(providerRows[days - 1].t).toISOString());
    expect(fetches).toBe(1);
  });
  test.each([
    { label: 'real MarketData', Service: MarketData, issues: [], status: 'ok' },
    { label: 'real MarketData plus nine fixture issues', Service: ManyIssuesMarketData, issues: fixtureIssues, status: 'partial' },
  ])('$label bounds model JSON without truncating details', async ({ Service, issues, status }) => {
    const providerRows = Array.from({ length: 13 }, (_, index) => {
      const strike = 100 + index;
      return { ...contract.results, details: { ...contract.results.details,
        ticker: `O:NIMB261106P${String(strike * 1000).padStart(8, '0')}`, strike_price: strike } };
    });
    let fetches = 0;
    const fixture = extension({ fetch: async input => {
      const url = new URL(input);
      expect(url.origin).toBe('https://api.polygon.io');
      expect(url.pathname).toBe('/v3/snapshot/options/NIMB');
      fetches++;
      return Response.json({ status: 'OK', results: providerRows });
    } }, Service);
    const tool = fixture.tools.get('get_option_chain');
    if (!tool) throw new Error('Option chain was not registered.');
    const result = await tool.execute('bounded', { symbol: 'NIMB' }, undefined, undefined, fixture.ctx);
    if (result.details.kind !== 'optionChain') throw new Error('Missing option chain details.');
    const full = result.details.result;
    expect(full.status).toBe(status);
    expect(full.rows).toHaveLength(13);
    expect(full.rows.map(row => row.occ)).toEqual(providerRows.map(row => row.details.ticker));
    expect(full.rows.every(row => row.bid === 0 && row.ask === 0.2 && row.volume === 0)).toBe(true);
    expect(full.issues).toEqual([...issues]);
    expect(modelSummary(result)).toEqual({
      kind: 'optionChain', query: { symbol: 'NIMB' }, status, provider: 'massive', source: 'network',
      asOf: '2026-10-30T20:00:00.123Z', fetchedAt: '2026-10-30T20:05:00.000Z',
      issues: issues.slice(0, 8), totalIssues: issues.length,
      totalRows: 13, shownRows: 10, omittedRows: 3, rows: full.rows.slice(0, 10),
      guidance: 'Option chain is truncated. Narrow side, expiry, or strikeRange and call get_option_chain again; do not treat these rows as exhaustive.',
    });
    expect(full.rows[12].occ).toBe('O:NIMB261106P00112000');
    if (issues.length > 8) expect(full.issues[8]).toBe('Fixture issue 9.');
    expect(fetches).toBe(1);
  });
  test('checks the actual model at every turn, aborting before continuation', async () => {
    for (const model of [undefined, { provider: 'anthropic', id: 'claude' }, { provider: 'openrouter', id: 'anthropic/claude' }, { provider: 'openai-codex', id: 'other' }]) {
      const fixture = extension(); fixture.ctx.model = model;
      expect(() => fixture.hook('turn_start')).toThrow();
      expect(fixture.aborted).toBe(true); expect(fixture.shutdown).toBe(true);
    }
  });
  test('enforces 12 turns and 24 tools, resetting only on a new input', async () => {
    const fixture = extension();
    for (let cycle = 0; cycle < 2; cycle++) {
      await fixture.hook('input');
      for (let i = 0; i < AGENT_LIMITS.maxTurns; i++) expect(() => fixture.hook('turn_start')).not.toThrow();
      expect(() => fixture.hook('turn_start')).toThrow('budget');
      for (let i = 0; i < AGENT_LIMITS.maxTools; i++) expect(await fixture.hook('tool_call', { toolName: 'hello', input: { name: 'Sean' } })).toBeUndefined();
      expect(await fixture.hook('tool_call', { toolName: 'hello', input: { name: 'Sean' } })).toEqual({ block: true, reason: 'Pi tool budget exceeded.' });
    }
    expect(fixture.hook('cache_warming_decision')).toEqual({ action: 'stop' });
  });
  test('native read follows both actual coach markdown links through canonical authorized paths', async () => {
    const fixture = extension();
    const coach = join(app, 'skills/option-coach');
    const markdown = await readFile(join(coach, 'SKILL.md'), 'utf8');
    const links = [...markdown.matchAll(/\]\((\.\.\/[^)]+\/SKILL\.md)\)/g)].map(match => match[1]);
    expect(links).toEqual(['../principle-facts-over-heuristics/SKILL.md', '../principle-advice-not-orders/SKILL.md']);
    for (const link of links) {
      const authorized = await realpath(resolve(coach, link));
      for (const [cwd, path] of [[app, `${coach}/${link}`], [app, `skills/option-coach/${link}`], [coach, link]]) {
        fixture.ctx.cwd = cwd;
        const input = { path, offset: 1, limit: 2000 };
        expect(await fixture.hook('tool_call', { toolName: 'read', input })).toBeUndefined();
        expect(input).toEqual({ path: authorized, offset: 1, limit: 2000 });
        expect(await readFile(input.path, 'utf8')).toBe(await readFile(authorized, 'utf8'));
      }
    }
  });
  test('native read normalizes an internal parent segment and forwards an absolute path', async () => {
    const fixture = extension();
    const input = { path: 'skills/option-coach/../option-coach/SKILL.md' };
    expect(await fixture.hook('tool_call', { toolName: 'read', input })).toBeUndefined();
    expect(input.path).toBe(await realpath(join(app, 'skills/option-coach/SKILL.md')));
    expect(await readFile(input.path, 'utf8')).toContain('name: option-coach');
  });
  test('native read never forwards raw intermediate symlink and parent traversal to execution', async () => {
    const fixture = extension();
    const outside = await mkdtemp(join(tmpdir(), 'option-read-outside-'));
    extensionCaches.push(outside);
    await mkdir(join(outside, 'child'));
    await mkdir(join(outside, 'option-coach'));
    const secret = 'Outside fixture must not reach native read.';
    await writeFile(join(outside, 'option-coach/SKILL.md'), secret);
    const link = join(app, 'skills', `test-parent-link-${crypto.randomUUID()}`);
    await symlink(join(outside, 'child'), link);
    try {
      const input = { path: `${link}/../option-coach/SKILL.md` };
      expect(await readFile(input.path, 'utf8')).toBe(secret);
      expect(await fixture.hook('tool_call', { toolName: 'read', input })).toBeUndefined();
      const authorized = await realpath(join(app, 'skills/option-coach/SKILL.md'));
      expect(input.path).toBe(authorized);
      const executed = await readFile(input.path, 'utf8');
      expect(executed).toBe(await readFile(authorized, 'utf8'));
      expect(executed).not.toContain(secret);
    } finally { await rm(link); }
  });
  test('native read rejects external traversal, external files and symlinks before execution', async () => {
    const fixture = extension();
    const link = join(app, 'skills', `test-link-${crypto.randomUUID()}.md`);
    const directoryLink = join(app, 'skills', `test-directory-link-${crypto.randomUUID()}`);
    const outsideLink = join(app, 'skills', `test-outside-link-${crypto.randomUUID()}.json`);
    await symlink(join(app, 'skills/option-coach/SKILL.md'), link);
    await symlink(join(app, 'skills/option-coach'), directoryLink);
    await symlink(join(app, 'package.json'), outsideLink);
    try {
      expect(await fixture.hook('tool_call', { toolName: 'read', input: { path: join(app, 'skills/option-coach/SKILL.md') } })).toBeUndefined();
      for (const path of [join(app, 'package.json'), 'skills/../package.json', 'skills/missing.md', link, join(directoryLink, 'SKILL.md'), outsideLink, 'skills', 4]) {
        expect(await fixture.hook('tool_call', { toolName: 'read', input: { path } })).toMatchObject({ block: true });
      }
      for (const toolName of ['bash', 'write', 'edit', 'codemode', 'unknown']) expect(await fixture.hook('tool_call', { toolName, input: {} })).toMatchObject({ block: true });
    } finally { await Promise.all([link, directoryLink, outsideLink].map(path => rm(path))); }
  });
});

describe('PiDriver over real subprocess pipes', () => {
  test.each(['valid', 'late-ack'])('hello text/tool/settled round trip with %s ACK', async mode => {
    await using(mode, async driver => {
      const views: AgentView[] = [];
      const unsubscribe = driver.subscribe(view => views.push(view));
      await driver.ask('Check hello transport.');
      expect(driver.view().connection).toEqual({ kind: 'ready', model: 'openai-codex/gpt-6.1-sol' });
      expect(driver.view().operation).toEqual({ kind: 'idle' });
      expect(driver.view().messages.map(message => message.text)).toEqual(['Check hello transport.', 'Transport check.', 'Hello, Sean! Advice only.']);
      expect(driver.view().tools).toEqual([{ id: 'hello-1', name: 'hello', input: { name: 'Sean' }, kind: 'succeeded', text: 'Hello, Sean!', hello: { kind: 'hello', name: 'Sean', greeting: 'Hello, Sean!', adviceOnly: true }, market: null }]);
      expect(views.some(view => view.messages.some(message => message.status === 'streaming'))).toBe(true);
      expect(views.some(view => view.tools.some(tool => tool.kind === 'running'))).toBe(true);
      const detached = driver.view(); detached.messages.length = 0;
      expect(driver.view().messages).toHaveLength(3);
      unsubscribe(); const count = views.length;
      await driver.ask('Again.');
      expect(views).toHaveLength(count);
    });
  });
  test('agent_end alone never releases the active operation', async () => {
    await using('delayed-settle', async driver => {
      const asking = driver.ask('hello');
      await until(() => driver.view().messages.at(-1)?.text === 'Hello, Sean! Advice only.');
      expect(driver.view().operation.kind).toBe('advice');
      await expect(driver.ask('second')).rejects.toThrow('busy');
      await expect(driver.command({ action: 'echo', text: 'second' })).rejects.toThrow('busy');
      await asking;
      expect(driver.view().operation.kind).toBe('idle');
    });
  });
  test.each(['queued', 'handled', 'missing-disposition', 'late-bad-ack'])('rejects %s advice disposition even after settlement', async mode => {
    await using(mode, async driver => {
      await expect(driver.ask('hello')).rejects.toThrow('did not start');
      expect(driver.view().operation.kind).toBe('failed'); expect(driver.view().connection.kind).toBe('failed');
    });
  });
  test('agent-end-only hits the operation deadline visibly', async () => {
    await using('agent-end-only', async driver => {
      await expect(driver.ask('hello')).rejects.toThrow('timed out');
      expect(driver.view().connection).toEqual({ kind: 'failed', error: 'Pi operation timed out.' });
    }, 120);
  });
  test('command-wrong-id fails immediately on correlation instead of waiting for the deadline', async () => {
    await using('command-wrong-id', async driver => {
      await expect(driver.command({ action: 'echo', text: 'test' })).rejects.toThrow(/correlation|request.?id|mismatch|unmatched/i);
      expect(driver.view().connection.kind).toBe('failed');
      expect(driver.view().operation.kind).toBe('failed');
    }, 10000);
  });
  test.each([
    ['turn-budget', 'turn budget'], ['tool-budget', 'tool budget'], ['forbidden-tool', 'not allowed'],
    ['duplicate-tool-end', 'duplicate tool end'], ['protocol-failure', 'Invalid Pi RPC'], ['bad-text', 'text'],
    ['provider-failure', 'Offline provider failure'], ['aborted', 'aborted'], ['turn-model-switch', 'non-anthropic'],
    ['read-outside', 'restricted'], ['read-traversal', 'restricted'],
  ])('fails closed on %s', async (mode, message) => {
    await using(mode, async driver => {
      await expect(driver.ask('hello')).rejects.toThrow(message);
      expect(driver.view().connection.kind).toBe('failed');
      expect(driver.view().operation.kind).toBe('failed');
      await expect(driver.ask('cannot silently restart')).rejects.toThrow('not ready');
    });
  });
  test('reads an actual skill only through the real extension gate', async () => {
    await using('read-valid', async driver => {
      await driver.ask('Read skill.');
      expect(driver.view().tools[0]).toMatchObject({ kind: 'succeeded', name: 'read', hello: null });
      const tool = driver.view().tools[0];
      if (tool.kind !== 'succeeded') throw new Error('Skill read failed.');
      expect(tool.text).toContain('name: option-coach');
    });
  });
  test('budgets reset per advice input at their exact limits', async () => {
    await using('at-limit', async driver => {
      await driver.ask('first'); await driver.ask('second');
      expect(driver.view().tools).toHaveLength(48);
      expect(driver.view().operation.kind).toBe('idle');
    });
  });
  test.each(['valid', 'command-entry-late'])('echo requires handled ACK plus a matching real command entry, %s', async mode => {
    await using(mode, async driver => {
      expect(await driver.command({ action: 'echo', text: '中文\nhello' })).toEqual({ requestId: 'echo-1', action: 'echo', status: 'ok', text: '中文\nhello', marker: 'option-agent', stage: 0 });
      expect(driver.view().messages).toEqual([]); expect(driver.view().tools).toEqual([]);
      expect(driver.view().operation.kind).toBe('idle');
    });
  });
  test.each(['command-started', 'command-malformed'])('echo rejects %s instead of starting model work', async mode => {
    await using(mode, async driver => {
      await expect(driver.command({ action: 'echo', text: 'test' })).rejects.toThrow();
      expect(driver.view().operation.kind).toBe('failed');
    });
  });
  test.each(['missing-marker', 'missing-skills', 'missing-command', 'bad-resources', 'wrong-model', 'anthropic-model', 'no-model', 'startup-busy'])('preflight failure %s stays visible and cannot ask', async mode => {
    const driver = new PiDriver(config(mode));
    try {
      await expect(driver.start()).rejects.toThrow();
      expect(driver.view().connection.kind).toBe('failed');
      expect(driver.view().operation.kind).toBe('failed');
      await expect(driver.ask('no')).rejects.toThrow('not ready');
    } finally { await driver.stop(); }
  });
  test('invalid config and missing executable fail visibly', async () => {
    for (const change of [(c: Config) => { c.model = 'anthropic/claude'; }, (c: Config) => { c.piBin = '/missing-option-agent-pi'; }]) {
      const c = config(); change(c); const driver = new PiDriver(c);
      try { await expect(driver.start()).rejects.toThrow(); expect(driver.view().connection.kind).toBe('failed'); }
      finally { await driver.stop(); }
    }
  });
  test('rejects empty/oversized inputs without damaging a healthy session', async () => {
    await using('valid', async driver => {
      for (const text of ['', ' ', 'a'.repeat(16001), '\0']) await expect(driver.ask(text)).rejects.toThrow();
      await expect(driver.command({ action: 'echo', text: 'x'.repeat(16001) })).rejects.toThrow();
      expect(driver.view().operation.kind).toBe('idle');
      await driver.ask('valid');
    });
  });
  test('stop cancels an ask and explicit restart creates a new empty session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'option-driver-'));
    const logPath = join(root, 'events.jsonl');
    const c = config('delayed-settle'); c.env.OPTION_AGENT_FAKE_LOG = logPath;
    const driver = new PiDriver(c);
    try {
      await driver.start();
      const asking = driver.ask('hello').catch((error: unknown) => error);
      await until(() => driver.view().messages.length > 1);
      await driver.stop();
      expect(String(await asking)).toContain('stopped');
      expect(driver.view().connection.kind).toBe('stopped');
      await expect(driver.start()).rejects.toThrow('restart');
      await driver.restart();
      expect(driver.view().messages).toEqual([]); expect(driver.view().tools).toEqual([]);
      await driver.command({ action: 'echo', text: 'fresh' });
      const launched = records(await readFile(logPath, 'utf8')).filter(record => record.type === 'launch');
      expect(launched).toHaveLength(2); expect(launched[0].pid).not.toBe(launched[1].pid);
      expect(() => process.kill(Number(launched[0].pid), 0)).toThrow();
    } finally { await driver.stop(); await rm(root, { recursive: true, force: true }); }
  });
  test('concurrent restarts share one fresh child and leave no orphan process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'option-restart-'));
    const logPath = join(root, 'events.jsonl');
    const c = config(); c.env.OPTION_AGENT_FAKE_LOG = logPath;
    const driver = new PiDriver(c);
    try {
      await driver.start();
      const first = driver.restart();
      expect(driver.restart()).toBe(first);
      await first;
      await driver.command({ action: 'echo', text: 'fresh' });
      await driver.stop();
      const launches = records(await readFile(logPath, 'utf8')).filter(record => record.type === 'launch');
      expect(launches).toHaveLength(2);
      for (const launch of launches) expect(() => process.kill(Number(launch.pid), 0)).toThrow();
    } finally { await driver.stop(); await rm(root, { recursive: true, force: true }); }
  });
  test('stop also cancels a queued restart before it can spawn', async () => {
    const driver = new PiDriver(config());
    try {
      await driver.start();
      const restarting = driver.restart().catch((error: unknown) => error);
      await driver.stop();
      expect(String(await restarting)).toContain('interrupted');
      expect(driver.view().connection.kind).toBe('stopped');
    } finally { await driver.stop(); }
  });
  test('a subscriber can cancel starting before any child is spawned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'option-start-stop-'));
    const logPath = join(root, 'events.jsonl');
    const c = config('hang'); c.env.OPTION_AGENT_FAKE_LOG = logPath;
    const driver = new PiDriver(c);
    let stopping: Promise<void> | undefined;
    const unsubscribe = driver.subscribe(view => { if (view.connection.kind === 'starting') stopping = driver.stop(); });
    try {
      await expect(driver.start()).rejects.toThrow('interrupted');
      await stopping;
      expect(driver.view().connection.kind).toBe('stopped');
      expect(await Bun.file(logPath).exists()).toBe(false);
    } finally { unsubscribe(); await driver.stop(); await rm(root, { recursive: true, force: true }); }
  });
  test('stopping startup never changes a stopped session back to ready', async () => {
    const driver = new PiDriver(config('hang'));
    const starting = driver.start().catch((error: unknown) => error);
    await driver.stop();
    expect(await starting).toBeInstanceOf(Error);
    expect(driver.view().connection.kind).toBe('stopped');
  });
  test('no-model command runs the actual extension, emits its error entry, and starts zero turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'option-command-'));
    const logPath = join(root, 'events.jsonl');
    const c = config(); c.env.OPTION_AGENT_FAKE_LOG = logPath;
    const events: RpcRecord[] = [];
    const child = new PiProcess(c, record => events.push(record));
    try {
      child.start();
      const ack = await child.request({ type: 'prompt', message: '/option-market {"requestId":"bad","action":"daily-bars"}' });
      expect(ack.data).toEqual({ disposition: 'handled' });
      const entry = events.find(record => record.type === 'entry_appended');
      expect(parseMarketResult(entry ? Object(entry.entry).data : null)).toMatchObject({ requestId: 'bad', status: 'error', error: expect.stringMatching(/invalid/i) });
      expect(events.some(record => record.type === 'turn_start')).toBe(false);
      const log = records(await readFile(logPath, 'utf8'));
      expect(log.some(record => record.type === 'turn_start' || record.type === 'hook')).toBe(false);
    } finally { await child.stop(); await rm(root, { recursive: true, force: true }); }
  });
});
