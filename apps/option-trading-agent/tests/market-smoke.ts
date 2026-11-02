import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { JsonlDecoder, type RpcRecord } from '../src/agent/jsonl.ts';
import type { AgentView, MarketQuery } from '../src/business/types.ts';
import type { DesktopBridge } from '../src/desktop.ts';

declare global { var optionAgent: DesktopBridge }

const app = resolve(import.meta.dir, '..');
const artifacts = join(app, 'artifacts');
const root = await mkdtemp(join(tmpdir(), 'option-market-smoke-'));
const fake = join(app, 'tests/fake-pi.ts');
const query: MarketQuery = { symbol: 'NIMB', days: 4, expiry: '2026-11-06', strikeRange: { min: 100, max: 105 } };
const assertions: { name: string; status: 'passed' | 'failed'; error?: string }[] = [];
const evidence: { mode: string; view: AgentView; fetches: number }[] = [];
const pids = new Set<number>();
const logs: string[] = [];
const errors: string[] = [];
const requests: string[] = [];
const responses: string[] = [];
let application: ElectronApplication | undefined;
let page: Page | undefined;
let logPath = '';
let current = 'launch';
let failure: unknown;
let networkHits = 0;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { networkHits++; return new Response('blocked probe'); } });
const target = `http://127.0.0.1:${server.port}/blocked`;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function dead(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (alive(pid)) {
    assert(Date.now() < deadline, `child ${pid} was not reaped`);
    await Bun.sleep(20);
  }
}

async function records(): Promise<RpcRecord[]> {
  const result: RpcRecord[] = [];
  const decoder = new JsonlDecoder(record => result.push(record));
  decoder.push(Buffer.from(await readFile(logPath, 'utf8'))); decoder.end();
  for (const record of result) if (record.type === 'launch' && typeof record.pid === 'number') pids.add(record.pid);
  return result;
}

async function pid(): Promise<number> {
  const value = (await records()).filter(record => record.type === 'launch').at(-1)?.pid;
  if (typeof value !== 'number') throw new Error('Missing fake Pi PID.');
  return value;
}

async function check(name: string, run: () => Promise<void>): Promise<void> {
  current = name;
  await run();
  assertions.push({ name, status: 'passed' });
  process.stdout.write(`PASS ${name}\n`);
}

async function idle(window: Page): Promise<void> {
  await window.waitForFunction(async () => {
    const view = await globalThis.optionAgent.view();
    return view.connection.kind === 'ready' && view.operation.kind === 'idle';
  });
  await window.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#load-market')?.disabled);
}

async function launch(mode: string): Promise<{ desktop: ElectronApplication; window: Page }> {
  logPath = join(root, `${mode}.jsonl`); logs.push(logPath);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '', HOME: root, PI_CODING_AGENT_DIR: join(root, 'pi-agent'),
    OPTION_AGENT_PI_BIN: fake, OPTION_AGENT_FAKE_LOG: logPath, OPTION_AGENT_FAKE_MODE: mode,
    OPTION_AGENT_MODEL: 'openai-codex/gpt-6.1-sol', OPTION_AGENT_TIMEOUT_MS: '15000',
    OPTION_AGENT_REQUEST_TIMEOUT_MS: '5000', OPTION_AGENT_SHUTDOWN_GRACE_MS: '80', PI_OFFLINE: '1', PI_TELEMETRY: '0',
  };
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'SYSTEMROOT', 'WINDIR']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.TMPDIR = root; env.TMP = root; env.TEMP = root;
  application = await electron.launch({
    executablePath: join(app, 'node_modules/.bin/electron'),
    args: [app, `--user-data-dir=${join(root, mode)}`], env, timeout: 20000,
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  page.on('response', response => { if (/^https?:/.test(response.url())) responses.push(response.url()); });
  await idle(page);
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  assert.equal(await page.title(), '期权交易助理');
  assert.equal(await page.locator('#connection').innerText(), 'Pi 已就绪');
  assert.equal(await page.locator('#market-title').innerText(), '行情数据');
  assert.equal(await page.locator('#load-market').innerText(), '加载');
  assert.equal(await page.locator('#daily-title').innerText(), '近期日线');
  assert.equal(await page.locator('#chain-title').innerText(), '期权链');
  assert.equal((await records()).filter(record => record.type === 'prompt').length, 0);
  return { desktop: application, window: page };
}

async function close(): Promise<void> {
  if (!application) return;
  const child = await pid();
  await application.close();
  await dead(child);
  application = undefined;
}

async function fill(window: Page): Promise<void> {
  await window.locator('#symbol').fill('NIMB');
  await window.locator('#days').fill('4');
  await window.locator('#expiry').fill('2026-11-06');
  await window.locator('#strike-min').fill('100');
  await window.locator('#strike-max').fill('105');
}

async function load(window: Page): Promise<void> {
  await window.locator('#load-market').click();
  await window.locator('#loaded-query').filter({ hasText: '已加载 NIMB' }).waitFor();
  await idle(window);
}

async function snapshot(mode: string, window: Page): Promise<void> {
  evidence.push({ mode, view: await window.evaluate(() => globalThis.optionAgent.view()),
    fetches: (await records()).filter(record => record.type === 'fixture_fetch').length });
}

try {
  await mkdir(artifacts, { recursive: true });
  await mkdir(join(root, 'pi-agent'));
  const { desktop, window } = await launch('market-valid');

  await check('idle Stage 1 has no automatic market fetch or model prompt and no credentials', async () => {
    assert.equal(await window.locator('#bars-rows tr, #chain-rows tr').count(), 0);
    assert.match(await window.locator('.eyebrow').first().innerText(), /第一阶段行情数据/);
    assert.equal(await window.locator('#loaded-query').innerText(), '尚未加载行情数据。');
    assert.equal(await window.locator('#display-expiry option').innerText(), '暂无返回的到期日');
    assert.deepEqual(await window.locator('#display-side option').allTextContents(), ['PUT + CALL', '仅 PUT', '仅 CALL']);
    assert.deepEqual(await window.locator('#bars-table th').allTextContents(), ['日期', '开盘价', '最高价', '最低价', '收盘价', '调整后成交量', '暂定数据']);
    assert.deepEqual(await window.locator('#chain-table th').allTextContents(), ['合约', '到期日', '类型', '行权价', '买价', '卖价', 'IV', 'Delta', 'Gamma', 'Theta', 'Vega', 'OI', '报价时间']);
    assert.equal((await records()).filter(record => record.type === 'fixture_fetch' || record.type === 'turn_start').length, 0);
    const runtime = await desktop.evaluate(({ app }) => ({
      userData: app.getPath('userData'), home: process.env.HOME, executable: process.env.OPTION_AGENT_PI_BIN,
      credentials: Object.keys(process.env).filter(key => /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|CREDENTIAL|MARKET_DATA_ENV_FILE)/i.test(key)),
    }));
    assert.deepEqual(runtime, { userData: join(root, 'market-valid'), home: root, executable: fake, credentials: [] });
  });

  await check('invalid market IPC is rejected before any command or fixture fetch', async () => {
    const before = (await records()).length;
    const rejected = await window.evaluate(async () => {
      const inputs: unknown[] = [
        { kind: 'market' }, { kind: 'market', query: null },
        ...[
          { symbol: '../NIMB', days: 4 }, { symbol: 'NIMB', days: 0 }, { symbol: 'NIMB', days: 501 },
          { symbol: 'NIMB', days: 1.5 }, { symbol: 'NIMB', days: '4' },
          { symbol: 'NIMB', days: 4, expiry: '2026-02-30' },
          { symbol: 'NIMB', days: 4, strikeRange: { min: 105, max: 100 } },
          { symbol: 'NIMB', days: 4, strikeRange: { min: 100 } },
          { symbol: 'NIMB', days: 4, apiKey: 'forged' },
        ].map(query => ({ kind: 'market', query })),
        { kind: 'market', query: { symbol: 'NIMB', days: 4 }, action: 'contract' },
        { kind: 'contract', occ: 'O:NIMB261106P00100000' }, { kind: 'fetch', url: 'https://example.test' },
      ];
      return Promise.all(inputs.map(input => Reflect.apply(globalThis.optionAgent.send, globalThis.optionAgent, [input])));
    });
    assert.equal(rejected.length, 14);
    for (const reply of rejected) assert.equal(reply.kind, 'error');
    assert.equal((await records()).length, before);
    await fill(window);
    await window.locator('#strike-max').fill('');
    await window.locator('#load-market').click();
    await window.locator('#error').filter({ hasText: '请同时填写最低和最高行权价，或将两项都留空。' }).waitFor();
    assert.equal((await records()).length, before);
    assert.equal(await window.locator('#bars-rows tr, #chain-rows tr').count(), 0);
  });

  await check('Load serializes commands and displays 4 bars plus 2 filtered chain rows without a model turn', async () => {
    await fill(window);
    await window.locator('#question').fill('Keep this unsent market draft');
    const child = await pid();
    process.kill(child, 'SIGSTOP');
    try {
      await window.locator('#load-market').click();
      await window.waitForFunction(async () => (await globalThis.optionAgent.view()).operation.kind === 'command');
      assert.equal(await window.locator('#load-market').isDisabled(), true);
      assert.equal(await window.locator('#send').isDisabled(), true);
      assert.equal(await window.locator('#restart').isDisabled(), true);
      assert.equal(await window.locator('#stop').isEnabled(), true);
      const replies = await window.evaluate(async query => [
        await globalThis.optionAgent.send({ kind: 'market', query }),
        await globalThis.optionAgent.send({ kind: 'ask', text: 'must not queue' }),
      ], query);
      for (const reply of replies) assert(reply.kind === 'error' && /busy/.test(reply.error));
    } finally { if (alive(child)) process.kill(child, 'SIGCONT'); }
    await idle(window);
    assert.equal(await window.locator('#bars-rows tr').count(), 4);
    assert.equal(await window.locator('#chain-rows tr').count(), 2);
    assert.equal(await window.locator('#bars-count').innerText(), '显示 4 行 / 返回 4 行 / 请求 4 天。未设置本地行数上限。');
    for (const value of await window.locator('#bars-rows td:last-child').allTextContents()) assert(['是', '否'].includes(value));
    assert.deepEqual(await window.locator('#chain-rows tr:first-child td').allTextContents(), [
      'O:NIMB261106P00100000', '2026-11-06', 'PUT', '100', '0', '0.2', '32%', '-0.18', '0.04', '-0.06', '0.11', '0', '2026-10-30T20:00:00.123Z',
    ]);
    assert.equal(await window.locator('#question').inputValue(), 'Keep this unsent market draft');
    const view = await window.evaluate(() => globalThis.optionAgent.view());
    assert.deepEqual(view.market?.query, query);
    assert.equal(view.messages.length, 0); assert.equal(view.tools.length, 0);
    for (const id of ['bars', 'chain']) {
      const metadata = await window.locator(`#${id}-metadata`).innerText();
      for (const value of ['状态 · 正常', '提供商', 'massive', '来源', '网络', '数据截至', '获取时间', '2026-10-30T20:05:00.000Z', '问题提示 · 暂无']) assert(metadata.includes(value), value);
    }
    const log = await records();
    assert.equal(log.filter(record => record.type === 'fixture_fetch').length, 2);
    assert.equal(log.filter(record => record.type === 'turn_start' || record.type === 'hook').length, 0);
    const command = log.find(record => record.type === 'prompt');
    assert.equal(JSON.parse(String(command?.message).slice('/option-market '.length)).action, 'market');
    const fetch = log.find(record => record.type === 'fixture_fetch' && record.path === '/v3/snapshot/options/NIMB');
    const params = new URLSearchParams(String(fetch?.search));
    assert.equal(params.get('expiration_date'), query.expiry);
    assert.equal(params.get('strike_price.gte'), '100'); assert.equal(params.get('strike_price.lte'), '105');
    await snapshot('filtered-network', window);
  });

  await check('PUT display filter is local and repeated Load preserves cache provenance and drafts', async () => {
    await window.locator('#display-side').selectOption('put');
    assert.equal(await window.locator('#chain-rows tr').count(), 1);
    assert.match(await window.locator('#chain-count').innerText(), /显示 1 行 \/ 所选到期日 2 行 \/ 共返回 2 行/);
    assert.equal((await records()).filter(record => record.type === 'fixture_fetch').length, 2);
    await load(window);
    assert.equal(await window.locator('#chain-rows tr').count(), 1);
    for (const result of ['bars', 'chain']) assert.match(await window.locator(`#${result}-metadata`).innerText(), /缓存/);
    assert.equal((await records()).filter(record => record.type === 'fixture_fetch').length, 2);
    assert.equal(await window.locator('#question').inputValue(), 'Keep this unsent market draft');
    await snapshot('filtered-cache', window);
  });

  await check('Agent executes all three real market tools and uses loaded symbol rather than unsent edits', async () => {
    await window.evaluate(() => {
      document.body.dataset.marketMutations = '0';
      const observer = new MutationObserver(records => {
        document.body.dataset.marketMutations = String(Number(document.body.dataset.marketMutations) + records.length);
      });
      for (const id of ['display-expiry', 'bars-rows', 'chain-rows']) {
        const target = document.getElementById(id);
        if (!target) throw new Error(`Missing ${id}`);
        observer.observe(target, { childList: true, subtree: true, characterData: true, attributes: true });
      }
      globalThis.addEventListener('stop-market-observer', () => observer.disconnect(), { once: true });
    });
    await window.locator('#symbol').fill('UNSENT');
    await window.locator('#question').fill('NIMB recent four days and November 6 PUT chain. Advice only.');
    const child = await pid(); process.kill(child, 'SIGSTOP');
    try {
      await window.locator('#send').click();
      await window.locator('#operation').filter({ hasText: /^处理中/ }).waitFor();
      assert.equal(await window.locator('#load-market').isDisabled(), true);
      const rejected = await window.evaluate(query => globalThis.optionAgent.send({ kind: 'market', query }), query);
      assert(rejected.kind === 'error' && /busy/.test(rejected.error));
      await window.locator('#question').fill('Next unsent draft');
    } finally { if (alive(child)) process.kill(child, 'SIGCONT'); }
    await idle(window);
    assert.equal(await window.evaluate(() => {
      globalThis.dispatchEvent(new Event('stop-market-observer'));
      return document.body.dataset.marketMutations;
    }), '0', 'streaming must not rebuild unchanged tables or invalidate the native expiry menu');
    assert.equal(await window.locator('#tools .tool.succeeded').count(), 3);
    assert.deepEqual(await window.locator('#tools .tool h3').allTextContents(), [
      'get_daily_bars · 成功', 'get_option_chain · 成功', 'get_contract · 成功',
    ]);
    const view = await window.evaluate(() => globalThis.optionAgent.view());
    for (const [index, tool] of view.tools.entries()) {
      assert(tool.kind === 'succeeded' && tool.market);
      assert.equal(tool.market.result.source, index < 2 ? 'cache' : 'network');
      assert.equal(tool.market.result.fetchedAt, view.market?.bars.fetchedAt);
      assert.match(tool.text, /status[\s\S]*provider[\s\S]*fetchedAt/);
    }
    assert.match(await window.locator('#transcript .assistant').last().innerText(), /Fixture market data retrieved/);
    assert.equal(await window.locator('#question').inputValue(), 'Next unsent draft');
    assert.equal(await window.locator('#symbol').inputValue(), 'UNSENT');
    assert.match(await window.locator('#loaded-query').innerText(), /已加载 NIMB/);
    const log = await records();
    assert.equal(log.filter(record => record.type === 'fixture_fetch').length, 3);
    for (const event of ['input', 'turn_start', 'tool_call']) assert(log.some(record => record.type === 'hook' && record.event === event));
    const prompt = log.filter(record => record.type === 'prompt').at(-1);
    const context = JSON.parse(String(prompt?.message).slice('/skill:option-coach '.length));
    assert.equal(context.selectedSymbol, 'NIMB');
    assert.equal(context.timeZone, 'America/New_York');
    assert.equal(context.question, view.messages[0]?.text);
    assert.equal(await window.locator('#display-expiry').inputValue(), '2026-11-06');
    await window.screenshot({ path: join(artifacts, 'market-smoke.png'), fullPage: true });
    await snapshot('market-tools', window);
  });

  await check('omitted expiry initially displays nearest returned expiry and switches locally with explicit counts', async () => {
    await window.locator('#symbol').fill('NIMB');
    await window.locator('#expiry').fill('');
    await window.locator('#strike-min').fill(''); await window.locator('#strike-max').fill('');
    await window.locator('#display-side').selectOption('all');
    await load(window);
    assert.deepEqual(await window.locator('#display-expiry option').allTextContents(), ['2026-11-06', '2026-11-13']);
    assert.equal(await window.locator('#display-expiry').inputValue(), '2026-11-06');
    assert.deepEqual(await window.locator('#chain-rows tr td:nth-child(2)').allTextContents(), ['2026-11-06', '2026-11-06']);
    assert.match(await window.locator('#chain-count').innerText(), /显示 2 行 \/ 所选到期日 2 行 \/ 共返回 3 行/);
    const before = await records();
    assert.equal(before.filter(record => record.type === 'fixture_fetch').length, 4);
    const fetch = before.filter(record => record.type === 'fixture_fetch').at(-1);
    assert.equal(new URLSearchParams(String(fetch?.search)).has('expiration_date'), false);
    await window.locator('#display-expiry').selectOption('2026-11-13');
    assert.equal(await window.locator('#chain-rows tr').count(), 1);
    assert.match(await window.locator('#chain-rows').innerText(), /2026-11-13/);
    assert.equal((await records()).length, before.length);
    assert.match(await window.locator('.market-note').innerText(), /可能受提供商限制而被截断/);
    assert.equal(await window.locator('#question').inputValue(), 'Next unsent draft');
    await snapshot('all-expiry-local-filter', window);
  });

  await check('market renderer has no Node, key, arbitrary IPC or permitted network access', async () => {
    assert.deepEqual(await window.evaluate(() => ({
      require: typeof Reflect.get(globalThis, 'require'), process: typeof Reflect.get(globalThis, 'process'),
      ipc: typeof Reflect.get(globalThis, 'ipcRenderer'), keys: Object.keys(globalThis.optionAgent).sort(),
    })), { require: 'undefined', process: 'undefined', ipc: 'undefined', keys: ['send', 'subscribe', 'view'] });
    assert(!JSON.stringify(await window.evaluate(() => globalThis.optionAgent.view())).includes('fixture-only-token'));
    const blocked = await window.evaluate(async target => { try { await fetch(target); return false; } catch { return true; } }, target);
    assert(blocked); assert.equal(networkHits, 0); assert.deepEqual(responses, []);
    assert(requests.every(url => url === target));
  });

  await check('Stop during market load reaps Pi and Restart preserves form and question drafts without refetch', async () => {
    const child = await pid(); process.kill(child, 'SIGSTOP');
    await window.locator('#load-market').click();
    await window.waitForFunction(async () => (await globalThis.optionAgent.view()).operation.kind === 'command');
    await window.locator('#stop').click();
    await window.locator('#connection').filter({ hasText: /^Pi 已停止$/ }).waitFor();
    await dead(child);
    assert.equal(await window.locator('#load-market').isDisabled(), true);
    assert.equal(await window.locator('#question').inputValue(), 'Next unsent draft');
    await window.locator('#restart').click(); await idle(window);
    assert.notEqual(await pid(), child);
    assert.equal(await window.locator('#symbol').inputValue(), 'NIMB');
    assert.equal(await window.locator('#days').inputValue(), '4');
    assert.equal(await window.locator('#question').inputValue(), 'Next unsent draft');
    assert.equal(await window.locator('#chain-rows tr, #bars-rows tr').count(), 0);
    assert.equal((await records()).filter(record => record.type === 'fixture_fetch').length, 4);
  });
  await close();

  for (const mode of ['market-partial', 'market-unavailable']) {
    await check(`${mode} launch displays missing values and honest result statuses`, async () => {
      const { window } = await launch(mode);
      await fill(window); await load(window);
      const status = mode === 'market-partial' ? '部分数据' : '不可用';
      assert.equal(await window.locator('#chain-metadata .result-status').innerText(), `状态 · ${status}`);
      assert.equal(await window.locator('#chain-metadata .result-issues li').count() > 0, true);
      assert.match(await window.locator('#chain-metadata').innerText(), /数据截至\s+缺失/);
      if (mode === 'market-partial') {
        assert.equal(await window.locator('#chain-rows tr').count(), 2);
        const cells = await window.locator('#chain-rows tr:first-child td').allTextContents();
        assert.deepEqual(cells.slice(4), Array(9).fill('缺失'));
        assert.equal(await window.locator('#bars-rows tr').count(), 4);
        assert.equal(await window.locator('#bars-metadata .result-status').innerText(), '状态 · 正常');
      } else {
        assert.equal(await window.locator('#chain-rows tr, #bars-rows tr').count(), 0);
        assert.equal(await window.locator('#bars-metadata .result-status').innerText(), '状态 · 不可用');
        assert.equal(await window.locator('#display-expiry').isDisabled(), true);
      }
      assert.equal((await records()).filter(record => record.type === 'turn_start' || record.type === 'hook').length, 0);
      await snapshot(mode, window);
      await close();
    });
  }
  assert.deepEqual(errors, []);
  for (const child of pids) assert.equal(alive(child), false, `orphan child ${child}`);
} catch (error) {
  failure = error;
  assertions.push({ name: current, status: 'failed', error: error instanceof Error ? error.message : String(error) });
  if (page && !page.isClosed()) await page.screenshot({ path: join(artifacts, 'market-smoke.failure.png'), fullPage: true }).catch(() => {});
} finally {
  for (const child of pids) if (alive(child)) { try { process.kill(child, 'SIGCONT'); } catch {} }
  if (application) await application.close().catch(() => {});
  for (const path of logs) {
    if (!await Bun.file(path).exists()) continue;
    const decoder = new JsonlDecoder(record => { if (record.type === 'launch' && typeof record.pid === 'number') pids.add(record.pid); });
    decoder.push(Buffer.from(await readFile(path, 'utf8'))); decoder.end();
  }
  for (const child of pids) if (alive(child)) {
    process.kill(child, 'SIGKILL'); await dead(child);
    failure ??= new Error(`Cleanup found orphan child ${child}.`);
  }
  server.stop(true);
  if (!failure) await rm(join(artifacts, 'market-smoke.failure.png'), { force: true });
  await writeFile(join(artifacts, 'market-smoke.json'), `${JSON.stringify({
    status: failure ? 'failed' : 'passed', timestamp: new Date().toISOString(),
    runtime: { electron: 'real', pi: 'tests/fake-pi.ts', extension: 'real', marketClient: 'real with fixture fetch', modelCalls: 0, liveDataCalls: 0 },
    assertions, evidence, pageErrors: errors, rendererHttpAttempts: requests, rendererHttpResponses: responses,
    networkHits, childPids: [...pids], childrenReaped: [...pids].every(child => !alive(child)),
  }, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
process.stdout.write(`Market Electron smoke passed. ${assertions.length} checks. Artifacts in artifacts/market-smoke.{png,json}\n`);
