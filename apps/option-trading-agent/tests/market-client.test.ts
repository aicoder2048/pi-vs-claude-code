import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarketData, loadCanonicalApiKey, MAX_RESPONSE_BYTES, type MarketDataOptions } from '../src/business/market-data/client.ts';
import { decodeDataResult } from '../src/business/market-data/normalize.ts';
import { object } from '../src/business/types.ts';
import { MarketDataCache } from '../src/business/market-data/cache.ts';
import bars from './fixtures/market/daily-bars.json';
import chain from './fixtures/market/option-chain.json';
import callsBeforePuts from './fixtures/market/calls-before-puts.ts';
import contract from './fixtures/market/contract.json';
import holidays from './fixtures/market/holidays.json';
import treasury from './fixtures/market/treasury.json';

const origin = 'https://api.polygon.io';
const chainPath = '/v3/snapshot/options/NIMB';
const current = Date.parse('2026-10-31T00:30:00.000Z');
const dirs: string[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const query = { symbol: 'NIMB', days: 4 };
const occ = 'O:NIMB261106P00100000';
const oneOption = { status: 'OK', results: [contract.results] };

afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function setup(options: MarketDataOptions = {}) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'option-market-'));
  dirs.push(cacheDir);
  const calls: { url: URL; init: RequestInit }[] = [];
  let now = current;
  const fixtureFetch: NonNullable<MarketDataOptions['fetch']> = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.origin !== origin) throw new Error('Unexpected fixture host.');
    if (/^\/v2\/aggs\/ticker\/NIMB\/range\/1\/day\/\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}$/.test(url.pathname)) return json(bars);
    if (url.pathname === chainPath) return json(chain);
    if (url.pathname === `${chainPath}/${occ}`) return json(contract);
    if (url.pathname === '/v1/marketstatus/upcoming') return json(holidays);
    if (url.pathname === '/fed/v1/treasury-yields') return json(treasury);
    throw new Error(`Unknown fixture URL ${url.pathname}`);
  };
  const config = { fetch: fixtureFetch, getApiKey: () => 'fixture-token', now: () => now, cacheDir, ...options };
  return { client: new MarketData(config), calls, cacheDir, config,
    advance: (ms: number) => { now += ms; } };
}

async function cacheFile(dir: string): Promise<string> {
  const names = (await readdir(dir)).filter(name => name.endsWith('.json'));
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/^[a-f0-9]{64}\.json$/);
  return join(dir, names[0]);
}

describe('market data service boundary', () => {
  test('five typed endpoints use bounded daily lookback, filters, underlying OCC and bearer-only auth', async () => {
    let credentials = 0;
    const env = await setup({ getApiKey: () => { credentials++; return 'fixture-token'; } });
    expect(credentials).toBe(0);
    expect(await env.client.dailyBars(query)).toMatchObject({ status: 'ok', rows: expect.any(Array) });
    expect(await env.client.optionChain({ symbol: 'nimb', expiry: '2026-11-06', strikeRange: { min: 100, max: 105 } }))
      .toMatchObject({ status: 'ok', rows: expect.any(Array) });
    expect(await env.client.contract({ occ: occ.slice(2) })).toMatchObject({ status: 'ok', rows: [{ occ }] });
    expect((await env.client.holidays()).status).toBe('ok');
    expect((await env.client.oneMonthTreasury()).rows).toEqual([{ date: '2026-10-30', annualRate: 0.0425 }]);
    expect(env.calls).toHaveLength(5);
    for (const { url, init } of env.calls) {
      expect(url.origin).toBe(origin);
      expect(url.href).not.toContain('fixture-token');
      expect(init.redirect).toBe('error');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-token');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(env.calls[0].url.pathname).toContain('/range/1/day/');
    const path = env.calls[0].url.pathname.split('/');
    expect(path.at(-1)).toBe('2026-10-30');
    expect(Date.parse(path.at(-1)!) - Date.parse(path.at(-2)!)).toBeGreaterThan(4 * 86_400_000);
    expect(env.calls[1].url.searchParams.get('expiration_date')).toBe('2026-11-06');
    expect(env.calls[1].url.searchParams.get('strike_price.gte')).toBe('100');
    expect(env.calls[1].url.searchParams.get('strike_price.lte')).toBe('105');
    expect(env.calls[4].url.searchParams.get('sort')).toBe('date.desc');
    expect(env.calls[4].url.searchParams.get('limit')).toBe('1');
    await env.client.dailyBars({ symbol: 'NIMB', days: 500 });
    const range = env.calls.at(-1)!.url.pathname.split('/');
    expect(Date.parse(range.at(-1)!) - Date.parse(range.at(-2)!)).toBeGreaterThan(730 * 86_400_000);
  });

  test('missing and failing injected credentials are unavailable without touching fetch', async () => {
    for (const getApiKey of [() => null, () => undefined, () => { throw new Error('PRIVATE_VALUE'); }, () => 'bad\nPRIVATE_VALUE']) {
      let requests = 0;
      const { client } = await setup({ getApiKey, fetch: async () => { requests++; throw new Error('No network allowed.'); } });
      const result = await client.holidays();
      expect(result).toMatchObject({ status: 'unavailable', rows: [], asOf: null });
      expect(JSON.stringify(result)).not.toContain('PRIVATE_VALUE');
      expect(requests).toBe(0);
    }
  });

  test('noncanonical env override cannot select a credential file or use the ambient key', async () => {
    const oldPath = process.env.MARKET_DATA_ENV_FILE, oldKey = process.env.POLYGON_API_KEY;
    try {
      process.env.MARKET_DATA_ENV_FILE = '/not-the-canonical-file';
      process.env.POLYGON_API_KEY = 'ambient-fixture-token';
      expect(await loadCanonicalApiKey()).toBeNull();
      new MarketData();
    } finally {
      if (oldPath === undefined) delete process.env.MARKET_DATA_ENV_FILE; else process.env.MARKET_DATA_ENV_FILE = oldPath;
      if (oldKey === undefined) delete process.env.POLYGON_API_KEY; else process.env.POLYGON_API_KEY = oldKey;
    }
  });

  test('HTTP permissions and rate limits are unavailable, other HTTP/network/JSON/provider failures are errors', async () => {
    for (const status of [401, 402, 403, 429, 500, 404, 302]) {
      let count = 0;
      const { client } = await setup({ fetch: async () => { count++; return json({ error: 'PRIVATE_VALUE' }, status); } });
      const result = await client.optionChain({ symbol: 'NIMB' });
      expect(result.status).toBe([401, 402, 403, 429].includes(status) ? 'unavailable' : 'error');
      expect(result.rows).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_VALUE');
      expect(count).toBe(1);
    }
    for (const fetch of [async () => { throw new Error('PRIVATE_VALUE'); }, async () => new Response('{broken PRIVATE_VALUE'),
      async () => json({ status: 'ERROR', error: 'PRIVATE_VALUE' }), async () => json({ status: 'OK' })]) {
      const { client } = await setup({ fetch });
      expect(await client.optionChain({ symbol: 'NIMB' })).toMatchObject({ status: 'error', rows: [] });
    }
    const { client } = await setup({ fetch: async () => json({ status: 'NOT_ENTITLED', error: 'PRIVATE_VALUE' }) });
    expect((await client.oneMonthTreasury()).status).toBe('unavailable');
  });

  test('explicit zero counts are empty, missing results are not, and missing desired fields remain partial and uncached', async () => {
    const { client } = await setup({ fetch: async () => json({ status: 'OK', resultsCount: 0 }) });
    expect((await client.dailyBars(query)).status).toBe('empty');
    expect((await client.optionChain({ symbol: 'NIMB' })).status).toBe('empty');
    expect((await client.contract({ occ })).status).toBe('empty');
    expect((await client.oneMonthTreasury()).status).toBe('empty');
    const emptyHoliday = await setup({ fetch: async () => json([]) });
    expect((await emptyHoliday.client.holidays()).status).toBe('empty');
    const incomplete = await setup({ fetch: async () => json({ status: 'PARTIAL', resultsCount: 0 }) });
    expect((await incomplete.client.optionChain({ symbol: 'NIMB' })).status).toBe('partial');
    const contradictory = await setup({ fetch: async () => json({ status: 'EMPTY', resultsCount: 5 }) });
    expect((await contradictory.client.optionChain({ symbol: 'NIMB' })).status).toBe('error');
    let calls = 0;
    const partial = await setup({ fetch: async () => { calls++; return json({ results: { details: contract.results.details } }); } });
    for (let i = 0; i < 2; i++) {
      const result = await partial.client.contract({ occ });
      expect(result).toMatchObject({ status: 'partial', rows: [{ occ, bid: null, iv: null, quotedAt: null }] });
    }
    expect(calls).toBe(2);
    expect(await readdir(partial.cacheDir)).toEqual([]);
  });

  test('invalid queries never request credentials or HTTP', async () => {
    const { client } = await setup({ getApiKey: () => { throw new Error('Must not load.'); } });
    expect((await client.dailyBars({ symbol: '../PRIVATE_VALUE', days: 5 })).status).toBe('error');
    expect((await client.optionChain({ symbol: 'NIMB', strikeRange: { min: 5, max: 1 } })).status).toBe('error');
    expect((await client.contract({ occ: 'PRIVATE_VALUE' })).status).toBe('error');
    expect(client.httpRequests).toBe(0);
    for (const maxPages of [0, 5, 1.5]) expect(() => new MarketData({ maxPages })).toThrow();
  });
});

describe('pagination and bounded transport', () => {
  test('all consumed pages produce ok, strip next_url credentials, and cache the aggregate', async () => {
    const calls: string[] = [];
    const { client, cacheDir } = await setup({ fetch: async url => {
      calls.push(url);
      return json(calls.length === 1 ? { ...oneOption, next_url: `${origin}${chainPath}?cursor=two&apiKey=PRIVATE_VALUE` } : oneOption);
    } });
    expect(await client.optionChain({ symbol: 'NIMB' })).toMatchObject({ status: 'ok', rows: [{ occ }, { occ }], issues: [] });
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toContain('PRIVATE_VALUE');
    expect((await client.optionChain({ symbol: 'NIMB' })).source).toBe('cache');
    expect(await readFile(await cacheFile(cacheDir), 'utf8')).not.toMatch(/PRIVATE_VALUE|fixture-token|next_url|apiKey/);
  });

  test('page caps, repeated/foreign/wrong-path URLs and later failures retain rows as partial, including zero rows', async () => {
    const scenarios = [
      { next: `${origin}${chainPath}?cursor=repeat`, fail: false, maxPages: 4, expected: 2 },
      { next: `${origin}${chainPath}?cursor=two`, fail: false, maxPages: 1, expected: 1 },
      { next: 'https://foreign.invalid/page', fail: false, maxPages: 4, expected: 1 },
      { next: `${origin}/v3/snapshot/options/OTHER`, fail: false, maxPages: 4, expected: 1 },
      { next: `${origin}${chainPath}?cursor=two`, fail: true, maxPages: 4, expected: 2 },
    ];
    for (const empty of [false, true]) for (const scenario of scenarios) {
      let calls = 0;
      const { client, cacheDir } = await setup({ maxPages: scenario.maxPages, fetch: async () => {
        calls++;
        if (calls > 1 && scenario.fail) return json({ error: 'PRIVATE_VALUE' }, 403);
        return json({ status: 'OK', results: empty ? [] : oneOption.results, next_url: scenario.next });
      } });
      const result = await client.optionChain({ symbol: 'NIMB' });
      expect(result.status).toBe('partial');
      expect(result.rows.length).toBe(empty ? 0 : scenario.expected - Number(scenario.fail));
      expect(calls).toBe(scenario.expected);
      expect(await readdir(cacheDir)).toEqual([]);
    }
  });

  test('wrong daily date ranges are errors, and aggregate row limits stay below the RPC byte ceiling', async () => {
    const wrong = await setup({ fetch: async () => json({ ...bars, results: [{ ...bars.results[0], t: Date.parse('2027-01-01T05:00:00Z') }] }) });
    expect(await wrong.client.dailyBars({ symbol: 'NIMB', days: 1 })).toMatchObject({ status: 'error', rows: [] });
    let count = 0;
    const many = await setup({ fetch: async () => json({ status: 'OK', results: Array(700).fill(contract.results),
      next_url: `${origin}${chainPath}?cursor=${++count}` }) });
    const result = await many.client.optionChain({ symbol: 'NIMB' });
    expect(result.status).toBe('partial');
    expect(result.rows).toHaveLength(1000);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(900_000);
  });

  test('normal operation caps at four pages and a cumulative budget counts every attempted HTTP request', async () => {
    let calls = 0;
    const fetch = async () => json({ ...oneOption, next_url: `${origin}${chainPath}?cursor=${++calls}` });
    const capped = await setup({ fetch });
    expect((await capped.client.optionChain({ symbol: 'NIMB' })).status).toBe('partial');
    expect(capped.client.httpRequests).toBe(4);
    calls = 0;
    const budgeted = await setup({ fetch, maxHttpRequests: 3 });
    expect((await budgeted.client.optionChain({ symbol: 'NIMB' })).status).toBe('partial');
    expect(budgeted.client.httpRequests).toBe(3);
    expect((await budgeted.client.holidays()).status).toBe('unavailable');
    expect(budgeted.client.httpRequests).toBe(3);
    expect(calls).toBe(3);
  });

  test('header and streamed byte limits reject oversized bodies, and stalled fetch/body time out', async () => {
    for (const fetch of [
      async () => new Response('{}', { headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } }),
      async () => new Response(' '.repeat(MAX_RESPONSE_BYTES + 1)),
      async () => new Promise<Response>(() => {}),
      async () => new Response(new ReadableStream({ start() {} })),
    ]) {
      const { client } = await setup({ fetch, timeout: 20 });
      const result = await client.holidays();
      expect(result.status).toBe('error');
      expect(result.rows).toEqual([]);
      expect(result.issues.join(' ')).toMatch(/size limit|timed out/);
      expect(client.httpRequests).toBe(1);
    }
  });
});

describe('validated cache and request sharing', () => {
  test('disk hits keep original timestamps, need no credentials and return independent clones', async () => {
    const env = await setup();
    const original = await env.client.optionChain({ symbol: 'NIMB' });
    env.advance(1000);
    const reopened = new MarketData({ ...env.config, getApiKey: () => { throw new Error('Must not read credentials.'); } });
    const cached = await reopened.optionChain({ symbol: 'nimb' });
    expect(cached).toEqual({ ...original, source: 'cache' });
    cached.rows[0].bid = 999;
    cached.issues.push('caller mutation');
    expect(await reopened.optionChain({ symbol: 'NIMB' })).toEqual({ ...original, source: 'cache' });
    expect(env.calls).toHaveLength(1);
  });

  test('omitted, PUT and CALL queries have separate flights and disk identities at the same expiry and range', async () => {
    const calls: URL[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const env = await setup({ fetch: async input => {
      calls.push(new URL(input));
      await gate;
      return json(callsBeforePuts);
    } });
    const base = { symbol: 'NIMB', expiry: '2026-11-06', strikeRange: { min: 100, max: 111 } };
    const queries = [base, { ...base, side: 'put' }, { ...base, side: 'call' }] satisfies Parameters<MarketData['optionChain']>[0][];
    const pending = queries.map(query => env.client.optionChain(query));
    const sharedPut = env.client.optionChain({ ...base, side: 'put' });
    try {
      for (let attempt = 0; calls.length < 3 && attempt < 100; attempt++) await Bun.sleep(5);
      expect(calls).toHaveLength(3);
      expect(calls.map(url => url.searchParams.get('contract_type')).sort()).toEqual([null, 'call', 'put'].sort());
      for (const url of calls) {
        expect(url.searchParams.get('expiration_date')).toBe(base.expiry);
        expect(url.searchParams.get('strike_price.gte')).toBe('100');
        expect(url.searchParams.get('strike_price.lte')).toBe('111');
      }
    } finally { release?.(); }
    const results = await Promise.all(pending);
    expect(results.map(result => result.status)).toEqual(['ok', 'ok', 'ok']);
    expect(results.map(result => result.rows.length)).toEqual([24, 12, 12]);
    expect(results[1].rows.every(row => row.side === 'put')).toBe(true);
    expect(results[2].rows.every(row => row.side === 'call')).toBe(true);
    expect(await sharedPut).toEqual(results[1]);
    const files = await readdir(env.cacheDir);
    expect(files).toHaveLength(3);
    const saved = await Promise.all(files.map(async name => JSON.parse(await readFile(join(env.cacheDir, name), 'utf8'))));
    expect(saved.map(entry => entry.query.side ?? null).sort()).toEqual([null, 'call', 'put'].sort());
    const reopened = new MarketData({ ...env.config,
      getApiKey: () => { throw new Error('Disk hits must not read credentials.'); },
      fetch: async () => { throw new Error('Disk hits must not fetch.'); },
    });
    for (const [index, query] of queries.entries()) {
      expect(await reopened.optionChain(query)).toEqual({ ...results[index], source: 'cache' });
    }
    expect(calls).toHaveLength(3);
  });

  test('opposite-side valid DTO rows cannot enter or survive a side-specific cache', async () => {
    let fetches = 0;
    const env = await setup({ fetch: async () => { fetches++; return json(callsBeforePuts); } });
    const base = { symbol: 'NIMB', expiry: '2026-11-06', strikeRange: { min: 100, max: 111 } };
    const putQuery = { ...base, side: 'put' } satisfies Parameters<MarketData['optionChain']>[0];
    const puts = await env.client.optionChain(putQuery);
    const file = await cacheFile(env.cacheDir);
    const calls = await env.client.optionChain({ ...base, side: 'call' });
    const cache = new MarketDataCache({ cacheDir: env.cacheDir, now: env.config.now });
    expect(decodeDataResult('optionChain', calls)).toEqual(calls);
    expect(await cache.put('optionChain', putQuery, calls)).toBe(false);
    const tampered = JSON.parse(await readFile(file, 'utf8'));
    tampered.result.rows[0] = calls.rows[0];
    expect(() => decodeDataResult('optionChain', tampered.result)).not.toThrow();
    await writeFile(file, JSON.stringify(tampered));
    expect(await cache.get('optionChain', putQuery, 30_000)).toBeNull();
    expect(await env.client.optionChain(putQuery)).toEqual(puts);
    expect(fetches).toBe(3);
  });

  test('endpoint TTLs expire at the boundary, daily keys include resolved date ranges', async () => {
    const cases = [
      { ttl: 30_000, run: (c: MarketData) => c.optionChain({ symbol: 'NIMB' }) },
      { ttl: 60_000, run: (c: MarketData) => c.dailyBars(query) },
      { ttl: 6 * 3_600_000, run: (c: MarketData) => c.oneMonthTreasury() },
      { ttl: 24 * 3_600_000, run: (c: MarketData) => c.holidays() },
    ];
    for (const { ttl, run } of cases) {
      const env = await setup();
      const first = await run(env.client);
      expect(first.status).toBe('ok');
      env.advance(ttl - 1);
      expect((await run(env.client)).source).toBe('cache');
      env.advance(1);
      expect((await run(env.client)).source).toBe('network');
      expect(env.calls).toHaveLength(2);
    }
    for (const [start, ttl] of [['2026-11-01T16:00:00.000Z', 4 * 3_600_000], ['2026-11-02T15:00:00.000Z', 60_000]] satisfies [string, number][]) {
      let clock = Date.parse(start);
      const historical = await setup({ now: () => clock });
      expect((await historical.client.dailyBars(query)).rows.every(row => !row.provisional)).toBe(true);
      clock += ttl - 1;
      expect((await historical.client.dailyBars(query)).source).toBe('cache');
      clock++;
      expect((await historical.client.dailyBars(query)).source).toBe('network');
    }
    const env = await setup();
    await env.client.dailyBars(query);
    const saved = JSON.parse(await readFile(await cacheFile(env.cacheDir), 'utf8'));
    expect(saved.query).toMatchObject({ ...query, from: expect.any(String), to: '2026-10-30' });
    env.advance(24 * 3_600_000);
    await env.client.dailyBars(query);
    expect(env.calls.at(-1)!.url.pathname).toEndWith('/2026-10-31');
  });

  test('corruption, wrong version/query/metadata/DTO/status and future fetch dates are misses', async () => {
    const env = await setup();
    await env.client.optionChain({ symbol: 'NIMB' });
    const file = await cacheFile(env.cacheDir);
    const clean = await readFile(file, 'utf8');
    type Envelope = { version: unknown; query: Record<string, unknown>; fetchedAt: unknown;
      result: Record<string, unknown> & { rows: Record<string, unknown>[] } };
    const mutations: ((e: Envelope) => string | void)[] = [
      () => '{broken',
      e => { e.version = 9; },
      e => { e.query.symbol = 'OTHER'; },
      e => { e.result.rows[0].bid = '12'; },
      e => { object(e.result.rows[0].greeks).delta = 7; },
      e => { e.result.rows[0].symbol = 'OTHER'; },
      e => { e.result.rows[0].extra = 'PRIVATE_VALUE'; },
      e => { e.result.status = 'partial'; e.result.issues = ['incomplete']; },
      e => { e.fetchedAt = '2027-01-01T00:00:00.000Z'; e.result.fetchedAt = e.fetchedAt; },
      e => { e.fetchedAt = '2026-10-30T00:00:00.000Z'; },
      e => { e.result.asOf = '2026-10-29T12:00:00.000Z'; },
      () => ' '.repeat(900_001),
    ];
    for (const mutate of mutations) {
      const envelope = JSON.parse(clean);
      const text = mutate(envelope) ?? JSON.stringify(envelope);
      await writeFile(file, text);
      expect((await env.client.optionChain({ symbol: 'NIMB' })).source).toBe('network');
    }
    expect(env.calls).toHaveLength(1 + mutations.length);
    expect(() => decodeDataResult('optionChain', { ...JSON.parse(clean).result, rows: [{}] })).toThrow('Invalid market data result.');
  });

  test('daily provisional tampering misses cache and cancelled queued writes cannot replace fresh data', async () => {
    const env = await setup();
    const first = await env.client.dailyBars(query);
    const file = await cacheFile(env.cacheDir);
    const envelope = JSON.parse(await readFile(file, 'utf8'));
    envelope.result.rows.at(-1).provisional = false;
    await writeFile(file, JSON.stringify(envelope));
    env.advance(60_001);
    expect((await env.client.dailyBars(query)).source).toBe('network');
    const cache = new MarketDataCache({ cacheDir: env.cacheDir, now: env.config.now });
    const old = await env.client.optionChain({ symbol: 'NIMB' });
    const controller = new AbortController();
    const cancelled = cache.put('optionChain', { symbol: 'NIMB' }, old, controller.signal);
    controller.abort();
    const newer = { ...old, fetchedAt: new Date(env.config.now()).toISOString() };
    const saved = cache.put('optionChain', { symbol: 'NIMB' }, newer);
    expect(await cancelled).toBe(false);
    expect(await saved).toBe(true);
    expect((await cache.get('optionChain', { symbol: 'NIMB' }, 30_000))?.fetchedAt).toBe(newer.fetchedAt);
    expect(first.rows).toHaveLength(4);
    expect((await readdir(env.cacheDir)).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  test('cache entries are bounded without keeping credential or temporary files', async () => {
    const env = await setup();
    const result = await env.client.optionChain({ symbol: 'NIMB' });
    const cache = new MarketDataCache({ cacheDir: env.cacheDir, now: env.config.now });
    for (let i = 0; i < 129; i++) {
      expect(await cache.put('optionChain', { symbol: 'NIMB', strikeRange: { min: i / 100, max: 1000 } }, result)).toBe(true);
    }
    const names = await readdir(env.cacheDir);
    expect(names).toHaveLength(128);
    expect(names.every(name => /^[a-f0-9]{64}\.json$/.test(name))).toBe(true);
  });

  test('write failures keep rows and expose only a safe persistence diagnostic', async () => {
    const env = await setup();
    const blocked = join(env.cacheDir, 'PRIVATE_VALUE');
    await writeFile(blocked, 'not a directory');
    const client = new MarketData({ ...env.config, cacheDir: blocked });
    const result = await client.optionChain({ symbol: 'NIMB' });
    expect(result.status).toBe('partial');
    expect(result.rows).toHaveLength(3);
    expect(result.issues).toEqual(['Market data cache write failed.']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_VALUE');
  });

  test('single-flight clones results and cancellation of one caller does not abort another', async () => {
    let release: ((value: Response) => void) | undefined;
    let started: (() => void) | undefined;
    const start = new Promise<void>(resolve => { started = resolve; });
    let networkSignal: AbortSignal | null | undefined;
    let calls = 0;
    const env = await setup({ fetch: async (_, init) => {
      calls++; networkSignal = init.signal; started?.();
      return new Promise<Response>(resolve => { release = resolve; });
    } });
    const controller = new AbortController();
    const cancelled = env.client.optionChain({ symbol: 'nimb' }, controller.signal);
    const retained = env.client.optionChain({ symbol: 'NIMB' });
    const other = env.client.optionChain({ symbol: 'NIMB' });
    await start;
    controller.abort();
    expect((await cancelled).status).toBe('error');
    expect(networkSignal?.aborted).toBe(false);
    release?.(json(chain));
    const [a, b] = await Promise.all([retained, other]);
    expect(a.status).toBe('ok');
    a.rows[0].bid = 999;
    expect(b.rows[0].bid).not.toBe(999);
    expect(calls).toBe(1);
  });

  test('pre-cancel and last-caller cancellation avoid cache poisoning and permit a fresh request', async () => {
    const pre = new AbortController(); pre.abort();
    let started: (() => void) | undefined;
    const start = new Promise<void>(resolve => { started = resolve; });
    let networkSignal: AbortSignal | null | undefined;
    let calls = 0;
    const env = await setup({ fetch: async (_, init) => {
      calls++; networkSignal = init.signal; started?.();
      return calls === 1 ? new Promise<Response>(() => {}) : json(chain);
    } });
    expect((await env.client.optionChain({ symbol: 'NIMB' }, pre.signal)).status).toBe('error');
    expect(calls).toBe(0);
    const controller = new AbortController();
    const waiting = env.client.optionChain({ symbol: 'NIMB' }, controller.signal);
    await start;
    controller.abort();
    expect((await waiting).status).toBe('error');
    expect(networkSignal?.aborted).toBe(true);
    expect((await env.client.optionChain({ symbol: 'NIMB' })).status).toBe('ok');
    expect(calls).toBe(2);
  });
});
