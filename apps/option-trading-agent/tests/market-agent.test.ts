import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/agent/config.ts';
import { PiDriver } from '../src/agent/driver.ts';
import { JsonlDecoder, type RpcRecord } from '../src/agent/jsonl.ts';
import { PiProcess } from '../src/agent/rpc.ts';
import { object, type AgentView, type MarketQuery, type MarketResult } from '../src/business/types.ts';
import {
  parseMarketQuery, parseMarketRequest, parseMarketResult, parseMarketToolResult, parseOptionChainInput, sameQuery,
} from '../src/business/market-data/protocol.ts';
import { normalizeOptionChain } from '../src/business/market-data/normalize.ts';
import callsBeforePuts from './fixtures/market/calls-before-puts.ts';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const occ = 'O:NIMB261106P00100000';
const query: MarketQuery = { symbol: 'NIMB', days: 4, expiry: '2026-11-06', strikeRange: { min: 100, max: 105 } };
const fetchedAt = '2026-10-30T20:05:00.000Z';
const toolNames = ['get_daily_bars', 'get_option_chain', 'get_contract'];
const sideQueries = [
  { label: 'omitted', query: { ...query, strikeRange: { min: 100, max: 111 } } },
  { label: 'put', query: { ...query, side: 'put', strikeRange: { min: 100, max: 111 } } },
  { label: 'call', query: { ...query, side: 'call', strikeRange: { min: 100, max: 111 } } },
] satisfies { label: string; query: MarketQuery }[];
const sideMismatches = sideQueries.flatMap(requested => sideQueries
  .filter(returned => returned.label !== requested.label)
  .map(returned => ({ label: `${requested.label}-as-${returned.label}`, query: requested.query })));

function config(mode: string, logPath: string) {
  return loadConfig(app, {
    PATH: process.env.PATH, OPTION_AGENT_PI_BIN: join(app, 'tests/fake-pi.ts'), OPTION_AGENT_FAKE_MODE: mode,
    OPTION_AGENT_FAKE_LOG: logPath, OPTION_AGENT_REQUEST_TIMEOUT_MS: '2000', OPTION_AGENT_TIMEOUT_MS: '10000',
    OPTION_AGENT_SHUTDOWN_GRACE_MS: '40',
  });
}
async function records(path: string): Promise<RpcRecord[]> {
  const result: RpcRecord[] = [];
  const decoder = new JsonlDecoder(record => result.push(record));
  decoder.push(Buffer.from(await readFile(path, 'utf8'))); decoder.end();
  return result;
}
async function using(mode: string, run: (driver: PiDriver, logPath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'option-market-agent-'));
  const logPath = join(root, 'events.jsonl');
  const driver = new PiDriver(config(mode, logPath));
  try { await driver.start(); await run(driver, logPath); }
  finally { await driver.stop(); await rm(root, { recursive: true, force: true }); }
}

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Condition timed out.');
    await Bun.sleep(5);
  }
}

const nyDate = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(Date.now());

describe('Stage 1 real extension tools over subprocess pipes', () => {
  test('all three tools return decoded market DTOs and preserve actual zero quotes', async () => {
    await using('market-tools', async driver => {
      await driver.ask('NIMB 最近走势和下周五的 PUT 链');
      expect(driver.view().operation.kind).toBe('idle');
      const tools = driver.view().tools;
      expect(tools.map(tool => tool.name)).toEqual(toolNames);
      expect(tools.every(tool => tool.kind === 'succeeded')).toBe(true);
      const daily = tools[0];
      const chain = tools[1];
      const contract = tools[2];
      if (daily.kind !== 'succeeded' || chain.kind !== 'succeeded' || contract.kind !== 'succeeded') throw new Error('Market tool failed.');
      expect(daily.hello).toBeNull();
      expect(daily.market).toMatchObject({ kind: 'dailyBars', query: { symbol: 'NIMB', days: 4 }, result: { status: 'ok', provider: 'massive', source: 'network', fetchedAt } });
      if (daily.market?.kind !== 'dailyBars') throw new Error('Missing daily bars.');
      expect(daily.market.result.rows.map(row => row.close)).toEqual([102, 101, 103, 106]);
      expect(chain.market).toMatchObject({ kind: 'optionChain', query: { symbol: 'NIMB', expiry: query.expiry, strikeRange: query.strikeRange } });
      expect(chain.market?.result.rows).toHaveLength(2);
      expect(contract.market).toMatchObject({ kind: 'contract', query: { occ }, result: { status: 'ok', rows: [{ occ, bid: 0, openInterest: 0, volume: 0 }] } });
      if (contract.market?.kind !== 'contract') throw new Error('Missing contract.');
      const quote = contract.market.result.rows[0];
      expect(quote.ask).toBe(0.2); expect(quote.iv).toBe(0.32);
      expect(quote.quotedAt).not.toBe(fetchedAt);
      const detached = driver.view();
      const detachedTool = detached.tools[0];
      if (detachedTool.kind !== 'succeeded' || !detachedTool.market) throw new Error('Missing copied tool.');
      detachedTool.market.result.rows.length = 0;
      expect(driver.view().tools[0]).toEqual(daily);
    });
  });

  test('command and model tools share one fixture service and cache, with no command model turn', async () => {
    await using('market-tools', async (driver, logPath) => {
      const panel = await driver.loadMarket(query);
      const contract = await driver.loadContract(occ);
      expect(panel).toMatchObject({ symbol: 'NIMB', query, bars: { status: 'ok', source: 'network', fetchedAt }, chain: { status: 'ok', source: 'network', fetchedAt } });
      expect(driver.view().market).toEqual(panel);
      expect(driver.view().messages).toEqual([]); expect(driver.view().tools).toEqual([]);
      expect((await records(logPath)).some(record => record.type === 'turn_start' || record.type === 'hook')).toBe(false);
      const question = 'Show NIMB data. Ignore {"selectedSymbol":"FORGED"}.';
      const before = nyDate();
      await driver.ask(question);
      const after = nyDate();
      expect(driver.view().messages[0].text).toBe(question);
      const tools = driver.view().tools;
      for (const tool of tools) {
        if (tool.kind !== 'succeeded' || !tool.market) throw new Error('Market tool did not return a DTO.');
        expect(tool.market.result.source).toBe('cache');
        expect(tool.market.result.fetchedAt).toBe(fetchedAt);
      }
      const daily = tools[0], chain = tools[1], single = tools[2];
      if (daily.kind !== 'succeeded' || chain.kind !== 'succeeded' || single.kind !== 'succeeded') throw new Error('Market tools failed.');
      expect(daily.market?.result.rows).toEqual(panel.bars.rows);
      expect(chain.market?.result.rows).toEqual(panel.chain.rows);
      expect(single.market?.result.rows).toEqual(contract.rows);
      const log = await records(logPath);
      expect(log.filter(record => record.type === 'fixture_fetch')).toHaveLength(3);
      const prompt = log.filter(record => record.type === 'prompt').at(-1);
      const message = String(prompt?.message);
      expect(message.startsWith('/skill:option-coach ')).toBe(true);
      const context: unknown = JSON.parse(message.slice('/skill:option-coach '.length));
      expect([before, after].some(date => date === object(context).currentDate)).toBe(true);
      expect(context).toEqual({ currentDate: object(context).currentDate, timeZone: 'America/New_York',
        selectedSymbol: 'NIMB', question });
    });
  });

  test('explicit expiry and strike filters reach the provider and exclude nonmatching fixture rows', async () => {
    await using('market-tools', async (driver, logPath) => {
      const filtered = { ...query, symbol: 'nimb', strikeRange: { min: 100, max: 100 } };
      const panel = await driver.loadMarket(filtered);
      expect(panel.symbol).toBe('NIMB');
      expect(panel.query).toEqual({ ...filtered, symbol: 'NIMB' });
      expect(panel.chain.rows.map(row => row.occ)).toEqual([occ]);
      const log = await records(logPath);
      const fetch = log.find(record => record.type === 'fixture_fetch' && record.path === '/v3/snapshot/options/NIMB');
      const params = new URLSearchParams(String(fetch?.search));
      expect(params.get('expiration_date')).toBe('2026-11-06');
      expect(params.get('strike_price.gte')).toBe('100'); expect(params.get('strike_price.lte')).toBe('100');
      const empty = await driver.loadMarket({ ...query, strikeRange: { min: 110, max: 120 } });
      expect(empty.chain).toMatchObject({ status: 'empty', rows: [], issues: [] });
      expect(driver.view().connection.kind).toBe('ready');
    });
  });

  test.each(sideQueries)('$label side survives actual command and tool pipes with distinct fixture identities', async ({ label, query }) => {
    await using(`market-side-${label}`, async (driver, logPath) => {
      const panel = await driver.loadMarket(query);
      expect(panel.query).toEqual(query);
      expect(panel.chain.status).toBe('ok');
      expect(panel.chain.rows).toHaveLength(label === 'omitted' ? 24 : 12);
      if (label !== 'omitted') expect(panel.chain.rows.every(row => row.side === label)).toBe(true);
      expect(driver.view().messages).toEqual([]);
      expect((await records(logPath)).some(record => record.type === 'turn_start' || record.type === 'hook')).toBe(false);
      await driver.ask(`Show the NIMB ${label} chain.`);
      const tool = driver.view().tools.find(tool => tool.name === 'get_option_chain');
      if (tool?.kind !== 'succeeded' || tool.market?.kind !== 'optionChain') throw new Error('Missing side chain tool.');
      const expectedQuery = parseOptionChainInput({ symbol: query.symbol, expiry: query.expiry,
        ...('side' in query ? { side: query.side } : {}), strikeRange: query.strikeRange });
      expect(tool.input).toEqual(expectedQuery);
      expect(tool.market.query).toEqual(expectedQuery);
      expect(tool.market.result).toEqual({ ...panel.chain, source: 'cache' });
      expect(JSON.parse(tool.text)).toMatchObject({ query: expectedQuery, totalRows: panel.chain.rows.length,
        shownRows: 10, omittedRows: panel.chain.rows.length - 10, rows: panel.chain.rows.slice(0, 10),
        guidance: expect.stringContaining('do not treat these rows as exhaustive') });
      const chainFetches = (await records(logPath)).filter(record => record.type === 'fixture_fetch' && record.path === '/v3/snapshot/options/NIMB');
      expect(chainFetches).toHaveLength(1);
      expect(new URLSearchParams(String(chainFetches[0].search)).get('contract_type')).toBe(label === 'omitted' ? null : label);
    });
  });

  test.each(sideMismatches)('tool identity rejects $label even when the alternative DTO is valid', async ({ label }) => {
    const mode = `market-side-${label}`;
    await using(mode, async (driver, logPath) => {
      await expect(driver.ask('Show NIMB options.')).rejects.toThrow('Market tool result differs from input.');
      expect(await records(logPath)).toContainEqual({ type: 'validated_fault', boundary: 'tool', mode });
      expect(driver.view().connection.kind).toBe('failed');
      expect(driver.view().tools.some(tool => tool.name === 'get_option_chain' && tool.kind === 'succeeded')).toBe(false);
    });
  });

  test('partial snapshots preserve nulls, issues and timestamps in commands and tools', async () => {
    await using('market-partial', async driver => {
      const panel = await driver.loadMarket(query);
      expect(panel.chain.status).toBe('partial');
      expect(panel.chain.issues.length).toBeGreaterThan(0);
      expect(panel.chain.rows[0]).toMatchObject({ bid: null, ask: null, iv: null, openInterest: null, volume: null, quotedAt: null,
        greeks: { delta: null, gamma: null, theta: null, vega: null } });
      expect(panel.chain.asOf).toBeNull();
      await driver.ask('Explain missing NIMB data.');
      for (const tool of driver.view().tools.slice(1)) {
        if (tool.kind !== 'succeeded' || !tool.market) throw new Error('Partial result was treated as transport failure.');
        expect(tool.market.result.status).toBe('partial');
        expect(tool.market.result.rows[0]).toMatchObject({ bid: null, ask: null });
      }
      expect(driver.view().operation.kind).toBe('idle');
    });
  });

  test('unavailable results are visible data limitations, not invented rows or transport errors', async () => {
    await using('market-unavailable', async driver => {
      const panel = await driver.loadMarket(query);
      const contract = await driver.loadContract(occ);
      for (const result of [panel.bars, panel.chain, contract]) {
        expect(result).toMatchObject({ status: 'unavailable', rows: [], asOf: null, provider: 'massive', source: 'network', fetchedAt });
        expect(result.issues.length).toBeGreaterThan(0);
      }
      await driver.ask('Explain unavailable data.');
      for (const tool of driver.view().tools) {
        if (tool.kind !== 'succeeded' || !tool.market) throw new Error('Unavailable result lost its DTO.');
        expect(tool.market.result.status).toBe('unavailable'); expect(tool.market.result.rows).toEqual([]);
      }
      expect(driver.view().connection.kind).toBe('ready');
      expect(driver.view().operation.kind).toBe('idle');
    });
  });

  test('unknown fixture routes fail closed without falling back to production fetch', async () => {
    await using('valid', async (driver, logPath) => {
      const panel = await driver.loadMarket({ symbol: 'UNKNOWN', days: 4 });
      expect(panel.bars).toMatchObject({ status: 'error', rows: [] });
      expect(panel.chain).toMatchObject({ status: 'error', rows: [] });
      expect((await records(logPath)).filter(record => record.type === 'fixture_fetch')).toEqual([]);
      expect(driver.view().connection.kind).toBe('ready');
    });
  });

  test.each(['market-tool-malformed', 'market-tool-query-mismatch', 'market-tool-wrong-kind', 'market-tool-wrong-row'])(
    '%s is rejected at the driver boundary', async mode => {
      await using(mode, async (driver, logPath) => {
        const correspondenceFault = ['market-tool-query-mismatch', 'market-tool-wrong-kind'].includes(mode);
        await expect(driver.ask('NIMB')).rejects.toThrow(correspondenceFault ? 'Market tool result differs from input.' : undefined);
        if (correspondenceFault) expect(await records(logPath)).toContainEqual({ type: 'validated_fault', boundary: 'tool', mode });
        expect(driver.view().connection.kind).toBe('failed');
        expect(driver.view().operation.kind).toBe('failed');
        expect(driver.view().tools.some(tool => tool.kind === 'succeeded')).toBe(false);
      });
    },
  );
});

describe('no-model market command protocol', () => {
  test.each(['valid', 'command-entry-late'])('%s requires both a matching market entry and handled ACK', async mode => {
    await using(mode, async driver => {
      const result = await driver.command({ action: 'market', query });
      expect(result).toMatchObject({ status: 'ok', action: 'market', panel: { query, symbol: 'NIMB' } });
      expect(driver.view().operation.kind).toBe('idle');
      expect(driver.view().messages).toEqual([]); expect(driver.view().tools).toEqual([]);
    });
  });

  test.each(sideMismatches)('command identity rejects $label even when the alternative panel is valid', async ({ label, query }) => {
    const mode = `command-side-${label}`;
    await using(mode, async (driver, logPath) => {
      await expect(driver.loadMarket(query)).rejects.toThrow('Market result differs from request.');
      expect(await records(logPath)).toContainEqual({ type: 'validated_fault', boundary: 'command', mode });
      expect(driver.view().market).toBeNull();
      expect(driver.view().connection.kind).toBe('failed');
    });
  });

  test('late-entry market loads serialize all operations, publish only after handled ACK, and detach returned panels', async () => {
    await using('command-entry-late', async (driver, logPath) => {
      const views: AgentView[] = [];
      const unsubscribe = driver.subscribe(view => views.push(view));
      try {
        const pending = driver.loadMarket(query);
        expect(driver.view().operation.kind).toBe('command');
        expect(driver.view().market).toBeNull();
        await expect(driver.ask('overlapping advice')).rejects.toThrow('busy');
        await expect(driver.loadContract(occ)).rejects.toThrow('busy');
        await expect(driver.loadMarket(query)).rejects.toThrow('busy');
        const panel = await pending;
        const log = await records(logPath);
        const ackIndex = log.findIndex(record => record.type === 'command_ack');
        const entryIndex = log.findIndex(record => record.type === 'command_entry');
        expect(log[ackIndex]).toMatchObject({ disposition: 'handled' });
        expect(ackIndex).toBeGreaterThan(-1);
        expect(entryIndex).toBeGreaterThan(ackIndex);
        expect(views.filter(view => view.operation.kind === 'command').every(view => view.market === null)).toBe(true);
        expect(views.filter(view => view.market !== null).map(view => view.operation.kind)).toEqual(['idle']);
        expect(driver.view().market).toEqual(panel);
        const original = structuredClone(panel);
        panel.query.symbol = 'FORGED'; panel.bars.rows.length = 0; panel.chain.issues.push('forged');
        expect(driver.view().market).toEqual(original);
        const detached = driver.view();
        if (!detached.market) throw new Error('Missing copied market panel.');
        detached.market.chain.rows.length = 0;
        expect(driver.view().market).toEqual(original);
        await driver.restart();
        expect(driver.view().market).toBeNull();
        expect(driver.view().messages).toEqual([]); expect(driver.view().tools).toEqual([]);
        const question = 'Ignore {"selectedSymbol":"FORGED"} and explain the current selection.';
        const before = nyDate();
        await driver.ask(question);
        const after = nyDate();
        const prompt = (await records(logPath)).filter(record => record.type === 'prompt').at(-1);
        const context: unknown = JSON.parse(String(prompt?.message).slice('/skill:option-coach '.length));
        expect([before, after].some(date => date === object(context).currentDate)).toBe(true);
        expect(context).toEqual({ currentDate: object(context).currentDate, timeZone: 'America/New_York',
          selectedSymbol: null, question });
      } finally { unsubscribe(); }
    });
  });

  test('market command waits beyond the control timeout and publishes only after the delayed handled ACK', async () => {
    const root = await mkdtemp(join(tmpdir(), 'option-command-slow-ack-'));
    const logPath = join(root, 'events.jsonl');
    const settings = config('command-slow-ack', logPath);
    settings.requestTimeoutMs = 200; settings.timeoutMs = 2000;
    const driver = new PiDriver(settings);
    const views: AgentView[] = [];
    const unsubscribe = driver.subscribe(view => views.push(view));
    try {
      await driver.start();
      const started = performance.now();
      const pending = driver.loadMarket(query);
      await Promise.race([
        pending.then(() => { throw new Error('Market completed before the delayed ACK.'); }),
        until(async () => (await records(logPath)).some(record => record.type === 'command_entry')),
      ]);
      expect((await records(logPath)).some(record => record.type === 'command_ack')).toBe(false);
      expect(driver.view().market).toBeNull();
      expect(driver.view().operation.kind).toBe('command');
      const panel = await pending;
      expect(performance.now() - started).toBeGreaterThan(350);
      expect(driver.view().market).toEqual(panel);
      expect(driver.view().operation.kind).toBe('idle');
      expect(views.filter(view => view.operation.kind === 'command').every(view => view.market === null)).toBe(true);
      const log = await records(logPath);
      expect(log.findIndex(record => record.type === 'command_ack')).toBeGreaterThan(log.findIndex(record => record.type === 'command_entry'));
      expect(driver.view().connection.kind).toBe('ready');
    } finally { unsubscribe(); await driver.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test.each([
    ['command-wrong-id', 'market'], ['command-wrong-action', 'market'], ['command-malformed', 'market'],
    ['command-started', 'market'], ['command-queued', 'market'], ['command-missing-disposition', 'market'],
    ['command-turn-start', 'market'], ['command-query-mismatch', 'market'], ['command-duplicate-entry', 'market'],
    ['command-wrong-contract', 'contract'],
  ])('%s fails visibly for %s without waiting for the 10-second operation deadline', async (mode, action) => {
    await using(mode, async (driver, logPath) => {
      const pending = action === 'contract' ? driver.loadContract(occ) : driver.loadMarket(query);
      const correspondenceFault = ['command-query-mismatch', 'command-wrong-contract'].includes(mode);
      await expect(pending).rejects.toThrow(correspondenceFault ? 'Market result differs from request.' : undefined);
      if (correspondenceFault) expect(await records(logPath)).toContainEqual({ type: 'validated_fault', boundary: 'command', mode });
      expect(driver.view().connection.kind).toBe('failed');
      expect(driver.view().operation.kind).toBe('failed');
      expect(driver.view().connection).not.toEqual({ kind: 'failed', error: 'Pi operation timed out.' });
    });
  });

  test.each([
    { requestId: 'bars', action: 'market', query },
    { requestId: 'contract', action: 'contract', occ },
    { requestId: 'echo', action: 'echo', text: 'unchanged' },
    { requestId: 'invalid', action: 'market', query: { ...query, days: 0 } },
    { requestId: 'invalid-occ', action: 'contract', occ: 'not-an-occ' },
  ])('$action command executes the actual extension with zero model turns, request $requestId', async request => {
    const root = await mkdtemp(join(tmpdir(), 'option-no-model-market-'));
    const logPath = join(root, 'events.jsonl');
    const events: RpcRecord[] = [];
    const child = new PiProcess(config('valid', logPath), record => events.push(record));
    try {
      child.start();
      const ack = await child.request({ type: 'prompt', message: `/option-market ${JSON.stringify(request)}` });
      expect(ack.data).toEqual({ disposition: 'handled' });
      const entry = events.find(record => record.type === 'entry_appended');
      const result = parseMarketResult(object(entry?.entry).data);
      expect(result.requestId).toBe(request.requestId);
      expect(result.status).toBe(request.requestId.startsWith('invalid') ? 'error' : 'ok');
      expect(events.some(record => record.type === 'turn_start' || record.type === 'agent_start')).toBe(false);
      expect((await records(logPath)).some(record => record.type === 'hook' || record.type === 'turn_start')).toBe(false);
    } finally { await child.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test('malformed local queries reject before transport and leave the healthy session usable', async () => {
    await using('valid', async (driver, logPath) => {
      for (const invalid of [
        { ...query, symbol: '../NIMB' }, { ...query, days: 0 }, { ...query, days: 501 },
        { ...query, expiry: '2026-02-30' }, { ...query, strikeRange: { min: 110, max: 100 } },
      ]) await expect(driver.loadMarket(invalid)).rejects.toThrow();
      await expect(driver.loadContract('not-an-occ')).rejects.toThrow();
      expect((await records(logPath)).filter(record => record.type === 'prompt')).toEqual([]);
      expect(driver.view().operation.kind).toBe('idle');
      await driver.loadMarket(query);
    });
  });

  test('protocol keeps side in canonical JSON identity and rejects opposite-side rows', async () => {
    await using('market-side-omitted', async driver => {
      const all = await driver.loadMarket(sideQueries[0].query);
      const canonicalQueries = sideQueries.map(({ query }) => parseMarketQuery(query));
      expect(new Set(canonicalQueries.map(query => JSON.stringify(query))).size).toBe(3);
      for (const [index, query] of canonicalQueries.entries()) {
        expect(parseMarketQuery(Object.fromEntries(Object.entries(query).reverse()))).toEqual(query);
        for (const [otherIndex, other] of canonicalQueries.entries()) expect(sameQuery(query, other)).toBe(index === otherIndex);
      }
      for (const side of ['put', 'call'] satisfies ('put' | 'call')[]) {
        const query = parseMarketQuery({ ...all.query, side });
        const chain = normalizeOptionChain(callsBeforePuts, query, { fetchedAt, source: 'network' });
        const opposite = normalizeOptionChain(callsBeforePuts, { ...query, side: side === 'put' ? 'call' : 'put' }, { fetchedAt, source: 'network' });
        const valid = { requestId: 'side-result', status: 'ok', action: 'market', panel: { ...all, query, chain } } satisfies MarketResult;
        expect(parseMarketResult(valid)).toEqual(valid);
        expect(() => parseMarketResult({ ...valid, panel: { ...valid.panel, chain: opposite } })).toThrow('Market chain differs from query.');
        const toolQuery = parseOptionChainInput({ symbol: query.symbol, expiry: query.expiry, side, strikeRange: query.strikeRange });
        expect(parseMarketToolResult({ kind: 'optionChain', query: toolQuery, result: chain })).toEqual({ kind: 'optionChain', query: toolQuery, result: chain });
        expect(() => parseMarketToolResult({ kind: 'optionChain', query: toolQuery, result: opposite })).toThrow('Market chain differs from query.');
      }
      for (const side of [undefined, null, '', 'PUT', 'CALL', 'both', 0, false, {}, []]) {
        expect(() => parseOptionChainInput({ symbol: 'NIMB', side })).toThrow();
        expect(() => parseMarketQuery({ ...all.query, side })).toThrow();
      }
    });
  });

  test('result decoder rejects malformed metadata, DTO rows, panel identities and unknown request fields', async () => {
    await using('valid', async driver => {
      const panel = await driver.loadMarket(query);
      const valid = { requestId: 'market-result', status: 'ok', action: 'market', panel } satisfies MarketResult;
      expect(parseMarketResult(valid)).toEqual(valid);
      for (const invalidPanel of [
        { ...panel, symbol: 'OTHER' },
        { ...panel, bars: { ...panel.bars, fetchedAt: 'yesterday' } },
        { ...panel, bars: { ...panel.bars, rows: [{ ...panel.bars.rows[0], symbol: 'OTHER' }] } },
        { ...panel, chain: { ...panel.chain, status: 'unavailable' } },
        { ...panel, chain: { ...panel.chain, rows: [{ ...panel.chain.rows[0], bid: -1 }] } },
      ]) expect(() => parseMarketResult({ ...valid, panel: invalidPanel })).toThrow();
      expect(() => parseMarketRequest({ requestId: 'r', action: 'market', query, apiKey: 'forged' })).toThrow();
      expect(() => parseMarketRequest({ requestId: 'r', action: 'contract', occ, text: 'extra' })).toThrow();
    });
  });
});

describe('Stage 1 skill capability contract', () => {
  test.each(['option-coach', 'principle-facts-over-heuristics'])('%s names available tools and provenance without Stage 0 claims', async name => {
    const text = await readFile(join(app, 'skills', name, 'SKILL.md'), 'utf8');
    expect(text.split('\n').length).toBeLessThan(200);
    expect(text).toMatch(/^---\nname: [a-z-]+\ndescription: .+\n---\n/);
    for (const tool of toolNames) expect(text).toContain(tool);
    for (const field of ['provider', 'source', 'asOf', 'fetchedAt', 'status', 'issues']) expect(text).toContain(field);
    expect(text).not.toContain('Stage 0 has no market-data tools');
    expect(text).toMatch(/scenario.grid/i);
    expect(text).toContain("side: 'put'");
    expect(text).toContain("side: 'call'");
    for (const field of ['totalRows', 'shownRows', 'omittedRows']) expect(text).toContain(field);
    expect(text).toMatch(/first ten rows.*not exhaustive/i);
  });
});
