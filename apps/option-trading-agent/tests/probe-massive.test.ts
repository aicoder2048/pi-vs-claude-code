import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, nextFriday, parseProbeArgs, runProbe } from '../scripts/probe-massive.ts';
import { MarketData, type MarketDataOptions } from '../src/business/market-data/client.ts';

const now = Date.parse('2026-11-02T15:00:00.000Z');
const occ = 'O:AAPL261106P00100000';
const dirs: string[] = [];
const dailyPayload = { status: 'OK', ticker: 'AAPL', results: Array.from({ length: 20 }, (_, index) => ({
  t: Date.parse(`2026-10-${String(index + 1).padStart(2, '0')}T04:00:00.000Z`),
  o: 100, h: 102, l: 98, c: 100, v: 1000,
})) };
const option = {
  details: { ticker: occ, expiration_date: '2026-11-06', contract_type: 'put', strike_price: 100 },
  underlying_asset: { ticker: 'AAPL' },
  last_quote: { bid: 0, ask: 1.25, last_updated: '1793631600000000000' },
  implied_volatility: 0.25, greeks: { delta: -0.5, gamma: 0, theta: -0.1, vega: 0.2 },
  open_interest: 0, day: { volume: 0 },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'massive-probe-test-'));
  dirs.push(dir);
  return dir;
}

async function setup({ replies = [() => json(dailyPayload), () => json({ status: 'OK', results: [option] }),
  () => json({ status: 'OK', results: option })], getApiKey = () => 'offline-probe-token' }: {
  replies?: (() => Response | Promise<Response>)[];
  getApiKey?: NonNullable<MarketDataOptions['getApiKey']>;
} = {}) {
  const dir = await directory();
  const artifactPath = join(dir, 'artifacts', 'massive-probe.json');
  const calls: URL[] = [];
  const unexpected: string[] = [];
  let keys = 0;
  const client = new MarketData({ maxHttpRequests: 3, maxPages: 1, cacheDir: join(dir, 'cache'), now: () => now,
    getApiKey: () => { keys++; return getApiKey(); },
    fetch: async (input, init) => {
      const url = new URL(input);
      const index = calls.length;
      calls.push(url);
      const allowed = [
        /^\/v2\/aggs\/ticker\/AAPL\/range\/1\/day\/\d{4}-\d{2}-\d{2}\/2026-11-02$/,
        /^\/v3\/snapshot\/options\/AAPL$/,
        /^\/v3\/snapshot\/options\/AAPL\/O:AAPL261106P00100000$/,
      ];
      const reply = replies[index];
      if (url.origin !== 'https://api.polygon.io' || !allowed[index]?.test(url.pathname) || !reply) {
        unexpected.push(url.pathname);
        throw new Error('Unexpected offline request.');
      }
      expect(init.redirect).toBe('error');
      return await reply();
    },
  });
  return { dir, client, artifactPath, calls, unexpected, keys: () => keys,
    run: (expiry?: string) => runProbe({ client, now: () => now, artifactPath, expiry }) };
}

describe('manual Massive probe', () => {
  test.each([
    ['2026-11-02T15:00:00.000Z', '2026-11-06'],
    ['2026-11-06T23:59:59.000Z', '2026-11-06'],
    ['2026-11-07T04:59:59.000Z', '2026-11-06'],
    ['2026-11-07T05:00:00.000Z', '2026-11-13'],
    ['2026-11-08T06:00:00.000Z', '2026-11-13'],
    ['2026-03-07T04:59:59.000Z', '2026-03-06'],
    ['2026-03-07T05:00:00.000Z', '2026-03-13'],
    ['2026-03-08T07:00:00.000Z', '2026-03-13'],
    ['2026-12-31T23:00:00.000Z', '2027-01-01'],
    ['2027-01-02T05:00:00.000Z', '2027-01-08'],
  ])('New York calendar Friday for %s is %s', (timestamp, friday) => {
    expect(nextFriday(Date.parse(timestamp))).toBe(friday);
  });

  test('requires an exact --run flag and safely parses symbol and holiday override', () => {
    expect(parseProbeArgs([])).toEqual({ kind: 'disabled' });
    expect(parseProbeArgs(['--run=true'])).toEqual({ kind: 'disabled' });
    expect(parseProbeArgs(['--symbol', 'AAPL'])).toEqual({ kind: 'disabled' });
    expect(parseProbeArgs(['--run'])).toEqual({ kind: 'run', symbol: 'AAPL' });
    expect(parseProbeArgs(['--symbol', 'brk.b', '--run', '--expiry', '2026-11-05']))
      .toEqual({ kind: 'run', symbol: 'BRK.B', expiry: '2026-11-05' });
    for (const args of [['--run', '--symbol', '../AAPL'], ['--run', '--symbol'],
      ['--run', '--expiry', '2026-02-30'], ['--run', '--expiry'], ['--run', '--run'],
      ['--run', '--symbol', 'AAPL', '--symbol', 'MSFT'], ['--run', '--unknown'],
      ['--run', '--symbol', 'AAPL\nPRIVATE'], ['--run', '--expiry', '2026-11-06?apiKey=PRIVATE']]) {
      expect(parseProbeArgs(args)).toEqual({ kind: 'invalid' });
    }
  });

  test('three actual attempts produce normalized data, close-derived filters, and a private artifact', async () => {
    const env = await setup();
    expect(env.keys()).toBe(0);
    const result = await env.run();
    expect(result.exitCode).toBe(0);
    expect(result.artifact).toMatchObject({ status: 'ok', httpRequests: 3, maxHttpRequests: 3, maxPages: 1,
      timestamp: new Date(now).toISOString(), quoteFields: 'complete',
      query: { daily: { symbol: 'AAPL', days: 20 },
        chain: { symbol: 'AAPL', expiry: '2026-11-06', strikeRange: { min: 99, max: 101 } }, contract: { occ } },
      checkpoints: { daily: { status: 'usable', httpRequests: 1 }, chain: { status: 'usable', httpRequests: 2 },
        contract: { status: 'usable', httpRequests: 3 } },
    });
    expect(result.artifact.results.daily?.rows).toHaveLength(20);
    expect(result.artifact.results.contract?.rows[0]).toMatchObject({ occ, bid: 0, openInterest: 0, volume: 0 });
    expect(Object.values(result.artifact.missingFields.chain).every(count => count === 0)).toBe(true);
    expect(env.calls).toHaveLength(3);
    expect(env.unexpected).toEqual([]);
    expect(env.calls[1].searchParams.get('expiration_date')).toBe('2026-11-06');
    expect(env.calls[1].searchParams.get('strike_price.gte')).toBe('99');
    expect(env.calls[1].searchParams.get('strike_price.lte')).toBe('101');
    const text = await readFile(env.artifactPath, 'utf8');
    expect((await stat(env.artifactPath)).mode & 0o777).toBe(0o600);
    await chmod(env.artifactPath, 0o644);
    const another = await setup();
    await runProbe({ client: another.client, now: () => now, artifactPath: env.artifactPath });
    expect((await stat(env.artifactPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(text)).toEqual(result.artifact);
    expect(text).not.toMatch(/offline-probe-token|api\.polygon\.io|Authorization|last_quote|apiKey|\.env/);
  });

  test('missing desired quote fields pass as partial usable rows, without claiming confirmed entitlement', async () => {
    const missing = { details: option.details };
    const env = await setup({ replies: [() => json(dailyPayload),
      () => json({ status: 'OK', results: [missing] }), () => json({ status: 'OK', results: missing })] });
    const result = await env.run();
    expect(result.exitCode).toBe(0);
    expect(result.artifact.status).toBe('partial');
    expect(result.artifact.quoteFields).toBe('missing-possibly-entitlement-limited');
    expect(result.artifact.missingFields.chain).toEqual({ bid: 1, ask: 1, iv: 1, delta: 1, gamma: 1,
      theta: 1, vega: 1, openInterest: 1, volume: 1, quotedAt: 1 });
    expect(result.artifact.limitations).toContain('Missing quote fields may reflect provider entitlements or absent market data. This probe cannot confirm the cause.');
    expect(env.calls).toHaveLength(3);
    expect(env.unexpected).toEqual([]);
  });

  test('one-page partial chain chooses the first valid normalized OCC without following next_url', async () => {
    const invalid = { details: { ...option.details, ticker: 'INVALID' } };
    const env = await setup({ replies: [() => json(dailyPayload),
      () => json({ status: 'OK', results: [invalid, option], next_url: 'https://api.polygon.io/v3/snapshot/options/AAPL?cursor=PRIVATE' }),
      () => json({ status: 'OK', results: option })] });
    const result = await env.run();
    expect(result.exitCode).toBe(0);
    expect(result.artifact.status).toBe('partial');
    expect(result.artifact.query.contract).toEqual({ occ });
    expect(result.artifact.results.chain?.issues).toContain('Provider page limit reached.');
    expect(env.calls).toHaveLength(3);
    expect(env.unexpected).toEqual([]);
    expect(await readFile(env.artifactPath, 'utf8')).not.toContain('PRIVATE');
  });

  test('short partial daily history remains usable and gets no retry', async () => {
    const env = await setup({ replies: [() => json({ ...dailyPayload, results: dailyPayload.results.slice(-2) }),
      () => json({ status: 'OK', results: [option] }), () => json({ status: 'OK', results: option })] });
    const result = await env.run();
    expect(result.artifact.status).toBe('partial');
    expect(result.exitCode).toBe(0);
    expect(result.artifact.results.daily?.rows).toHaveLength(2);
    expect(result.artifact.results.daily?.issues).toContain('Insufficient daily history.');
    expect(env.calls).toHaveLength(3);
  });

  test.each([0, 1, 2])('failed HTTP attempt at checkpoint %i is counted and never retried', async failureIndex => {
    const replies = [() => json(dailyPayload), () => json({ status: 'OK', results: [option] }),
      () => json({ status: 'OK', results: option })];
    replies[failureIndex] = () => { throw new Error('PRIVATE_NETWORK_ERROR https://secret.invalid?apiKey=SECRET'); };
    const env = await setup({ replies });
    const result = await env.run();
    expect(result.exitCode).toBe(1);
    expect(result.artifact.status).toBe('failed');
    expect(result.artifact.httpRequests).toBe(failureIndex + 1);
    expect(env.calls).toHaveLength(failureIndex + 1);
    expect(env.unexpected).toEqual([]);
    expect(await readFile(env.artifactPath, 'utf8')).not.toMatch(/PRIVATE_NETWORK_ERROR|SECRET|secret\.invalid/);
  });

  test.each(['daily', 'chain', 'contract'])('empty %s rows fail even when preceding results are usable', async stage => {
    const replies = [() => json(dailyPayload), () => json({ status: 'OK', results: [option] }),
      () => json({ status: 'OK', results: option })];
    const index = stage === 'daily' ? 0 : stage === 'chain' ? 1 : 2;
    replies[index] = () => json({ status: 'OK', results: stage === 'contract' ? null : [] });
    const env = await setup({ replies });
    const result = await env.run();
    expect(result.exitCode).toBe(1);
    expect(result.artifact.checkpoints[stage === 'daily' ? 'daily' : stage === 'chain' ? 'chain' : 'contract'])
      .toMatchObject({ status: 'unusable', reason: 'no-usable-rows' });
    expect(env.calls).toHaveLength(index + 1);
  });

  test('partial with zero rows is failure, not successful degraded coverage', async () => {
    const env = await setup({ replies: [() => json(dailyPayload), () => json({ status: 'PARTIAL', results: [] })] });
    const result = await env.run();
    expect(result.exitCode).toBe(1);
    expect(result.artifact.results.chain?.status).toBe('partial');
    expect(result.artifact.checkpoints.contract.status).toBe('not-run');
    expect(result.artifact.httpRequests).toBe(2);
  });

  test('credential unavailability writes a failure artifact with zero HTTP attempts', async () => {
    const env = await setup({ getApiKey: () => null });
    const result = await env.run();
    expect(result.exitCode).toBe(1);
    expect(result.artifact.httpRequests).toBe(0);
    expect(result.artifact.checkpoints.daily.reason).toBe('credentials-unavailable');
    expect(env.calls).toEqual([]);
    expect(env.keys()).toBe(1);
    expect(JSON.parse(await readFile(env.artifactPath, 'utf8')).status).toBe('failed');
  });

  test('HTTP entitlement failure is unavailable, not partial quote-field coverage', async () => {
    const env = await setup({ replies: [() => json(dailyPayload), () => json({ error: 'PRIVATE_ENTITLEMENT' }, 403)] });
    const result = await env.run();
    expect(result.exitCode).toBe(1);
    expect(result.artifact.results.chain?.status).toBe('unavailable');
    expect(result.artifact.quoteFields).toBe('not-observed');
    expect(result.artifact.httpRequests).toBe(2);
    expect(await readFile(env.artifactPath, 'utf8')).not.toContain('PRIVATE_ENTITLEMENT');
  });

  test('arbitrary service diagnostics never enter the normalized artifact', async () => {
    const env = await setup();
    const client = {
      get httpRequests() { return env.client.httpRequests; },
      dailyBars: async (query: Parameters<MarketData['dailyBars']>[0]) => ({
        ...await env.client.dailyBars(query), status: 'partial' as const,
        issues: ['https://secret.invalid?apiKey=PRIVATE', 'Authorization: Bearer PRIVATE'],
      }),
      optionChain: env.client.optionChain.bind(env.client),
      contract: env.client.contract.bind(env.client),
    };
    const result = await runProbe({ client, now: () => now, artifactPath: env.artifactPath });
    expect(result.exitCode).toBe(0);
    expect(result.artifact.status).toBe('partial');
    expect(result.artifact.results.daily?.issues).toEqual(['Unclassified market data issue.']);
    expect(await readFile(env.artifactPath, 'utf8')).not.toMatch(/PRIVATE|secret\.invalid|Authorization/);
  });

  test('a service exception still writes a safe failure artifact', async () => {
    const dir = await directory();
    let attempts = 0;
    const client = { get httpRequests() { return attempts; },
      dailyBars: async () => { attempts++; throw new Error('PRIVATE_SERVICE_ERROR'); },
      optionChain: async () => { throw new Error('Unexpected chain.'); },
      contract: async () => { throw new Error('Unexpected contract.'); },
    };
    const artifactPath = join(dir, 'probe.json');
    const result = await runProbe({ client, artifactPath, now: () => now });
    expect(result.exitCode).toBe(1);
    expect(result.artifact.httpRequests).toBe(1);
    expect(result.artifact.checkpoints.daily.reason).toBe('request-failed');
    expect(await readFile(artifactPath, 'utf8')).not.toContain('PRIVATE_SERVICE_ERROR');
  });

  test('an injected budget-consuming service cannot cause another logical request after three attempts', async () => {
    const base = await setup();
    const daily = await base.client.dailyBars({ symbol: 'AAPL', days: 20 });
    let attempts = 0;
    let chainCalls = 0;
    const client = { get httpRequests() { return attempts; },
      dailyBars: async () => { attempts = 3; return daily; },
      optionChain: async () => { chainCalls++; throw new Error('Unexpected chain.'); },
      contract: async () => { throw new Error('Unexpected contract.'); },
    };
    const result = await runProbe({ client, artifactPath: base.artifactPath, now: () => now });
    expect(result.exitCode).toBe(1);
    expect(result.artifact.httpRequests).toBe(3);
    expect(chainCalls).toBe(0);
    expect(result.artifact.checkpoints.chain.reason).toBe('budget-exhausted');
  });

  test('holiday expiry override is passed unchanged; a past expiry performs no HTTP', async () => {
    const env = await setup({ replies: [() => json(dailyPayload), () => json({ status: 'OK', results: [] })] });
    const result = await env.run('2026-11-05');
    expect(result.artifact.query.chain?.expiry).toBe('2026-11-05');
    expect(env.calls[1].searchParams.get('expiration_date')).toBe('2026-11-05');
    const past = await setup();
    expect((await past.run('2026-10-30')).exitCode).toBe(1);
    expect(past.calls).toEqual([]);
    expect(await readFile(past.artifactPath, 'utf8')).not.toBeEmpty();
  });

  test('import and no-run main never construct a client or perform file, network, or process operations', async () => {
    const dir = await directory();
    const script = fileURLToPath(new URL('../scripts/probe-massive.ts', import.meta.url));
    const clientModule = fileURLToPath(new URL('../src/business/market-data/client.ts', import.meta.url));
    const runner = join(dir, 'guard.ts');
    await writeFile(runner, `
      import { mock } from 'bun:test';
      const forbidden = () => { throw new Error('Forbidden side effect.'); };
      mock.module(${JSON.stringify(clientModule)}, () => ({ MarketData: class { constructor() { forbidden(); } } }));
      mock.module('node:fs/promises', () => ({ mkdir: forbidden, writeFile: forbidden, rename: forbidden, rm: forbidden }));
      globalThis.fetch = forbidden;
      Bun.spawn = forbidden;
      Bun.spawnSync = forbidden;
      const { main } = await import(${JSON.stringify(script)});
      const result = await main([]);
      if (result.exitCode !== 0 || !result.summary.startsWith('status=disabled ')) throw new Error('Guard failed.');
      const invalid = await main(['--run', '--symbol', '../PRIVATE']);
      if (invalid.exitCode !== 2 || invalid.summary.includes('PRIVATE')) throw new Error('Argument guard failed.');
      process.stdout.write('guard-passed');
    `);
    const home = await directory();
    const child = Bun.spawn([process.execPath, '--no-env-file', runner], {
      cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: home }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(),
      new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('guard-passed');
    expect(await readdir(dir)).toEqual(['guard.ts']);
  });

  test('production main constructs only bounded fresh-cache clients and emits count-only summaries', async () => {
    const dir = await directory();
    const script = fileURLToPath(new URL('../scripts/probe-massive.ts', import.meta.url));
    const clientModule = fileURLToPath(new URL('../src/business/market-data/client.ts', import.meta.url));
    const normalizerModule = fileURLToPath(new URL('../src/business/market-data/normalize.ts', import.meta.url));
    const artifactPath = join(dir, 'artifacts', 'massive-probe.json');
    const runner = join(dir, 'main.ts');
    await writeFile(runner, `
      import { mock } from 'bun:test';
      import { readFile } from 'node:fs/promises';
      import { normalizeDailyBars, normalizeOptionChain, normalizeContract } from ${JSON.stringify(normalizerModule)};
      const check = (value) => { if (!value) throw new Error('Production configuration or summary failed.'); };
      const forbidden = () => { throw new Error('Forbidden real side effect.'); };
      Date.now = () => ${now};
      const metadata = { fetchedAt: new Date(Date.now()).toISOString(), source: 'network' };
      const daily = normalizeDailyBars(${JSON.stringify(dailyPayload)}, { symbol: 'AAPL', days: 20 }, metadata);
      const option = ${JSON.stringify(option)};
      const chain = normalizeOptionChain({ status: 'OK', results: [option] }, { symbol: 'AAPL' }, metadata);
      const contract = normalizeContract({ status: 'OK', results: option }, { occ: ${JSON.stringify(occ)} }, metadata);
      const configs = [];
      class FakeMarketData {
        requests = 0;
        get httpRequests() { return this.requests; }
        constructor(options) {
          check(options.maxHttpRequests === 3 && options.maxPages === 1);
          check(Object.keys(options).sort().join(',') === 'cacheDir,maxHttpRequests,maxPages');
          check(options.cacheDir.startsWith(${JSON.stringify(artifactPath.replace(/massive-probe\.json$/, 'massive-probe-cache-'))}));
          configs.push(options);
        }
        async dailyBars(query) { this.requests++; return daily; }
        async optionChain(query) { this.requests++; return chain; }
        async contract(query) { this.requests++; return contract; }
      }
      mock.module(${JSON.stringify(clientModule)}, () => ({ MarketData: FakeMarketData }));
      globalThis.fetch = forbidden;
      Bun.spawn = forbidden;
      Bun.spawnSync = forbidden;
      const { main } = await import(${JSON.stringify(script)});
      for (let index = 0; index < 2; index++) {
        const result = await main(['--run'], { artifactPath: ${JSON.stringify(artifactPath)} });
        check(result.exitCode === 0 && result.summary.startsWith('status=ok httpRequests=3 '));
        check(result.summary.includes('rows={"daily":20,"chain":1,"contract":1}'));
        check(!/offline-probe-token|greeks|1\\.25|Authorization|apiKey/.test(result.summary));
      }
      check(configs.length === 2 && configs[0].cacheDir !== configs[1].cacheDir);
      check(JSON.parse(await readFile(${JSON.stringify(artifactPath)}, 'utf8')).httpRequests === 3);
      process.stdout.write('main-passed');
    `);
    const home = await directory();
    const child = Bun.spawn([process.execPath, '--no-env-file', runner], {
      cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: home }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(),
      new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('main-passed');
    expect((await readdir(dir)).sort()).toEqual(['artifacts', 'main.ts']);
    expect(await readdir(join(dir, 'artifacts'))).toEqual(['massive-probe.json']);
  });

  test('actual CLI without --run prints only a disabled summary and writes no artifact', async () => {
    const dir = await directory();
    const script = fileURLToPath(new URL('../scripts/probe-massive.ts', import.meta.url));
    const artifactPath = fileURLToPath(new URL('../artifacts/massive-probe.json', import.meta.url));
    const previous = await readFile(artifactPath, 'utf8').catch(() => null);
    const home = await directory();
    const child = Bun.spawn([process.execPath, '--no-env-file', script], {
      cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: home }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(),
      new Response(child.stderr).text(), child.exited]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('status=disabled httpRequests=0 rows=0 missingFields=0 artifact=none\n');
    expect(stderr).toBe('');
    expect(await readdir(dir)).toEqual([]);
    expect(await readFile(artifactPath, 'utf8').catch(() => null)).toBe(previous);
    expect(await main(['--run', '--symbol', 'bad/key'])).toEqual({ exitCode: 2,
      summary: 'status=invalid httpRequests=0 rows=0 missingFields=0 artifact=none' });
  });
});
