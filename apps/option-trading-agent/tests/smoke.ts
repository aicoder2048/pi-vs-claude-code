import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { JsonlDecoder, type RpcRecord } from '../src/agent/jsonl.ts';
import type { DesktopBridge } from '../src/desktop.ts';

declare global { var optionAgent: DesktopBridge }

const app = resolve(import.meta.dir, '..');
const artifacts = join(app, 'artifacts');
const root = await mkdtemp(join(tmpdir(), 'option-electron-smoke-'));
const logPath = join(root, 'fake-pi.jsonl');
const fake = join(app, 'tests/fake-pi.ts');
const assertions: { name: string; status: 'passed' | 'failed'; error?: string }[] = [];
const pageErrors: string[] = [];
const diagnostics: string[] = [];
const requests: string[] = [];
const responses: string[] = [];
const pids = new Set<number>();
let application: ElectronApplication | undefined;
let electronProcess: ReturnType<ElectronApplication['process']> | undefined;
let page: Page | undefined;
let failure: unknown;
let current = 'launch';
const runtimeEvidence: { userData: string; home: string | undefined; piDirectory: string | undefined; piExecutable: string | undefined; credentialVariableNames: string[] }[] = [];
let hits = 0;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { hits++; return new Response('unexpected network'); } });
const target = `http://127.0.0.1:${server.port}/blocked`;

async function check(name: string, run: () => Promise<void>): Promise<void> {
  current = name;
  await run();
  assertions.push({ name, status: 'passed' });
  process.stdout.write(`PASS ${name}\n`);
}

async function records(): Promise<RpcRecord[]> {
  const result: RpcRecord[] = [];
  const decoder = new JsonlDecoder(record => result.push(record));
  decoder.push(Buffer.from(await readFile(logPath, 'utf8')));
  decoder.end();
  for (const record of result) if (record.type === 'launch' && typeof record.pid === 'number') pids.add(record.pid);
  return result;
}

async function latestPid(): Promise<number> {
  const launches = (await records()).filter(record => record.type === 'launch');
  const pid = launches.at(-1)?.pid;
  assert.equal(typeof pid, 'number', 'fake-pi must log its actual PID');
  if (typeof pid !== 'number') throw new Error('Missing fake-pi PID.');
  return pid;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function untilDead(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (alive(pid)) {
    assert(Date.now() < deadline, `child ${pid} must be reaped`);
    await Bun.sleep(20);
  }
}

async function ready(window: Page): Promise<void> {
  await window.waitForFunction(async () => (await globalThis.optionAgent.view()).connection.kind === 'ready');
  await window.locator('#connection').filter({ hasText: /^Pi 已就绪$/ }).waitFor();
}

try {
  await mkdir(artifacts, { recursive: true });
  await access(fake, constants.X_OK);
  await access(join(app, 'dist/main.cjs'));
  await mkdir(join(root, 'pi-agent'));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '', HOME: root,
    PI_CODING_AGENT_DIR: join(root, 'pi-agent'),
    OPTION_AGENT_PI_BIN: fake, OPTION_AGENT_FAKE_LOG: logPath,
    OPTION_AGENT_FAKE_MODE: 'valid', OPTION_AGENT_MODEL: 'openai-codex/gpt-6.1-sol',
    OPTION_AGENT_TIMEOUT_MS: '15000', OPTION_AGENT_REQUEST_TIMEOUT_MS: '5000',
    OPTION_AGENT_SHUTDOWN_GRACE_MS: '80', PI_OFFLINE: '1', PI_TELEMETRY: '0',
  };
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'SYSTEMROOT', 'WINDIR']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  application = await electron.launch({
    executablePath: join(app, 'node_modules/.bin/electron'),
    args: [app, `--user-data-dir=${join(root, 'profile')}`], env,
    timeout: 20000,
  });
  electronProcess = application.process();
  electronProcess.stderr?.on('data', chunk => diagnostics.push(String(chunk)));
  page = await application.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  page.on('response', response => { if (/^https?:/.test(response.url())) responses.push(response.url()); });
  const desktop = application;
  const window = page;

  await check('real Electron starts only the explicit fake-pi with an idle desktop', async () => {
    await ready(window);
    const observed = await desktop.evaluate(({ app }) => ({
      userData: app.getPath('userData'), home: process.env.HOME,
      piDirectory: process.env.PI_CODING_AGENT_DIR, piExecutable: process.env.OPTION_AGENT_PI_BIN,
      credentialVariableNames: Object.keys(process.env).filter(key => /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|CREDENTIAL)/i.test(key)),
    }));
    runtimeEvidence.push(observed);
    assert.equal(observed.userData, join(root, 'profile'));
    assert.equal(observed.home, root);
    assert.equal(observed.piDirectory, join(root, 'pi-agent'));
    assert.equal(observed.piExecutable, fake);
    assert.deepEqual(observed.credentialVariableNames, []);
    assert.equal(await window.title(), '期权交易助理');
    assert.equal(await window.locator('html').getAttribute('lang'), 'zh-CN');
    assert.equal(await window.locator('h1').innerText(), '期权交易助理');
    assert.equal(await window.locator('.advice-label').innerText(), '仅供参考，不构成投资建议。不下单，不连接券商。');
    assert.equal(await window.locator('#send').innerText(), '发送');
    assert.equal(await window.locator('#stop').innerText(), '停止');
    assert.equal(await window.locator('#restart').innerText(), '重启 Pi');
    assert.equal(await window.locator('#operation').innerText(), '可以提问');
    assert.equal(await window.locator('#transcript .empty').innerText(), '输入问题开始对话。系统不会自动发送任何内容。');
    assert.equal(await window.locator('#tools .empty').innerText(), '尚未调用工具。');
    assert.equal(await window.locator('#model').innerText(), 'openai-codex/gpt-6.1-sol');
    assert.equal(await window.locator('#send').isDisabled(), true);
    assert.equal(await window.locator('#transcript .message').count(), 0);
    assert.equal(await window.locator('#tools .tool').count(), 0);
    const log = await records();
    assert.equal(log.filter(record => record.type === 'launch').length, 1);
    assert.equal(log.filter(record => record.type === 'prompt').length, 0);
    const args = log.find(record => record.type === 'launch')?.args;
    assert(Array.isArray(args));
    assert(args.includes('--mode') && args.includes('rpc') && args.includes('--no-session'));
    assert(args.includes(join(app, 'extensions/option-agent')));
    assert(args.includes(join(app, 'skills')));
    assert(alive(await latestPid()));
  });

  await check('sandbox, context isolation and the narrow preload bridge are active', async () => {
    const preferences = await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('No Electron window.');
      const method = Reflect.get(window.webContents, 'getLastWebPreferences');
      if (typeof method !== 'function') throw new Error('Electron cannot expose web preferences.');
      const value: unknown = Reflect.apply(method, window.webContents, []);
      if (!value || typeof value !== 'object') throw new Error('Invalid Electron web preferences.');
      return Object.fromEntries(['sandbox', 'contextIsolation', 'nodeIntegration', 'webviewTag', 'webSecurity', 'allowRunningInsecureContent'].map(key => [key, Reflect.get(value, key)]));
    });
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.webviewTag, false);
    assert.equal(preferences.webSecurity, true);
    assert.equal(preferences.allowRunningInsecureContent, false);
    assert.deepEqual(await window.evaluate(() => ({
      require: typeof Reflect.get(globalThis, 'require'), process: typeof Reflect.get(globalThis, 'process'),
      Buffer: typeof Reflect.get(globalThis, 'Buffer'), ipc: typeof Reflect.get(globalThis, 'ipcRenderer'),
      bridge: Object.keys(globalThis.optionAgent).sort(),
    })), { require: 'undefined', process: 'undefined', Buffer: 'undefined', ipc: 'undefined', bridge: ['send', 'subscribe', 'view'] });
  });

  await check('malformed and non-allowlisted IPC commands are rejected without starting a prompt', async () => {
    const before = (await records()).filter(record => record.type === 'prompt').length;
    const rejected = await window.evaluate(async () => {
      const inputs: unknown[] = [null, [], {}, { kind: 'echo' }, { kind: 'ask', text: '' },
        { kind: 'ask', text: 5 }, { kind: 'ask', text: 'bad\0text' }, { kind: 'ask', text: 'x'.repeat(16001) },
        { kind: 'ask', text: 'valid', model: 'other/model' }, { kind: 'stop', extra: true },
        { kind: 'restart', env: {} }, { type: 'prompt', message: 'bypass' }];
      return Promise.all(inputs.map(input => Reflect.apply(globalThis.optionAgent.send, globalThis.optionAgent, [input])));
    });
    assert.equal(rejected.length, 12);
    for (const reply of rejected) {
      assert(reply && typeof reply === 'object');
      assert.equal(Reflect.get(reply, 'kind'), 'error');
      assert.equal(typeof Reflect.get(reply, 'error'), 'string');
    }
    assert.equal((await records()).filter(record => record.type === 'prompt').length, before);
    assert.equal((await window.evaluate(() => globalThis.optionAgent.view())).connection.kind, 'ready');
  });

  await check('a second real window with the same preload and URL cannot invoke host IPC', async () => {
    const result = await desktop.evaluate(async ({ BrowserWindow }, paths) => {
      const other = new BrowserWindow({ show: false, webPreferences: {
        preload: paths.preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
      } });
      try {
        await other.loadURL(paths.url);
        return await other.webContents.executeJavaScript(`Promise.all([
          window.optionAgent.view().then(() => 'accepted view', error => String(error)),
          window.optionAgent.send({kind:'stop'}).then(() => 'accepted command', error => String(error))
        ])`);
      } finally { other.destroy(); }
    }, { preload: join(app, 'dist/preload.cjs'), url: window.url() });
    assert(Array.isArray(result) && result.length === 2);
    for (const rejection of result) assert.match(String(rejection), /Untrusted desktop sender/);
    await ready(window);
    assert(alive(await latestPid()));
  });

  await check('UI send shows the actual extension hello result and matching tool logs', async () => {
    const question = 'Check hello transport. 中文';
    await window.locator('#question').fill(question);
    await window.locator('#send').click();
    await window.locator('#tools .tool.succeeded').waitFor();
    await window.waitForFunction(async () => (await globalThis.optionAgent.view()).operation.kind === 'idle');
    assert.equal(await window.locator('#transcript .user .message-text').innerText(), question);
    assert.deepEqual(await window.locator('#transcript .assistant .message-text').allTextContents(), ['Transport check.', 'Hello, Sean! Advice only.']);
    assert.equal(await window.locator('#tools .tool h3').innerText(), 'hello · 成功');
    assert.equal(await window.locator('#tools .tool .tool-id').innerText(), 'hello-1');
    assert.match(await window.locator('#tools .tool').innerText(), /Sean[\s\S]*Hello, Sean!/);
    assert.equal(await window.locator('#question').inputValue(), '');
    const log = await records();
    const prompt = log.find(record => record.type === 'prompt' && typeof record.message === 'string' && record.message.startsWith('/skill:option-coach '));
    assert(prompt && typeof prompt.message === 'string');
    const context: unknown = JSON.parse(prompt.message.slice('/skill:option-coach '.length));
    assert(context && typeof context === 'object' && 'question' in context && context.question === question);
    assert('timeZone' in context && context.timeZone === 'America/New_York');
    assert('selectedSymbol' in context && context.selectedSymbol === null);
    assert('currentDate' in context && /^\d{4}-\d{2}-\d{2}$/.test(String(context.currentDate)));
    for (const event of ['input', 'turn_start', 'tool_call']) {
      assert(log.some(record => record.type === 'hook' && record.event === event), `actual extension hook ${event} ran`);
    }
    const tool = (await window.evaluate(() => globalThis.optionAgent.view())).tools[0];
    assert(tool?.kind === 'succeeded' && tool.hello?.greeting === 'Hello, Sean!' && tool.hello.adviceOnly);
    await window.screenshot({ path: join(artifacts, 'electron-smoke.png'), fullPage: true });
  });

  await check('busy state rejects a second ask and preserves a new draft across updates', async () => {
    const pid = await latestPid();
    process.kill(pid, 'SIGSTOP');
    try {
      await window.locator('#question').fill('Paused transport request');
      await window.locator('#send').click();
      await window.locator('#operation').filter({ hasText: /^处理中/ }).waitFor();
      assert.equal(await window.locator('#send').isDisabled(), true);
      assert.equal(await window.locator('#restart').isDisabled(), true);
      const result = await window.evaluate(() => globalThis.optionAgent.send({ kind: 'ask', text: 'must not queue' }));
      assert(result.kind === 'error' && /busy/.test(result.error));
      await window.locator('#question').fill('保留这份未发送草稿');
    } finally { if (alive(pid)) process.kill(pid, 'SIGCONT'); }
    await window.waitForFunction(async () => (await globalThis.optionAgent.view()).operation.kind === 'idle');
    assert.equal(await window.locator('#question').inputValue(), '保留这份未发送草稿');
    assert.equal(await window.locator('#send').isEnabled(), true);
  });

  await check('HTML and script text stay literal in both assistant and tool output', async () => {
    const markup = '<img src=x onerror="globalThis.xss=1"><script>globalThis.xss=2</script>';
    const snapshot = await window.evaluate(() => globalThis.optionAgent.view());
    const tool = snapshot.tools[0];
    assert(tool?.kind === 'succeeded');
    const injected = structuredClone(snapshot);
    injected.messages.push({ id: 'xss-check', role: 'assistant', status: 'complete', text: markup });
    injected.tools = [{ ...tool, input: { name: markup }, text: markup }];
    await desktop.evaluate(({ BrowserWindow }, view) => {
      const primary = BrowserWindow.getAllWindows()[0];
      if (!primary) throw new Error('Missing primary window.');
      primary.webContents.send('option-agent:update', view);
    }, injected);
    await window.locator('#transcript .assistant .message-text').filter({ hasText: markup }).waitFor();
    assert.equal(await window.locator('#tools .tool pre').first().innerText(), JSON.stringify({ name: markup }, null, 2));
    assert.equal(await window.locator('#tools .tool pre').last().innerText(), markup);
    assert.equal(await window.locator('#transcript img, #transcript script, #tools img, #tools script').count(), 0);
    assert.equal(await window.evaluate(() => Reflect.get(globalThis, 'xss')), undefined);
    assert.equal(await window.locator('#question').inputValue(), '保留这份未发送草稿');
  });

  await check('CSP blocks inline scripts, images and fetch before any network request', async () => {
    const result = await window.evaluate(async target => {
      const violations: string[] = [];
      const receive = (event: SecurityPolicyViolationEvent): void => { violations.push(event.effectiveDirective); };
      document.addEventListener('securitypolicyviolation', receive);
      const script = document.createElement('script');
      script.textContent = 'globalThis.cspExecuted = true';
      document.body.append(script);
      const image = document.createElement('img');
      image.src = target;
      document.body.append(image);
      let blocked = false;
      try { await fetch(target); } catch { blocked = true; }
      await new Promise(resolve => setTimeout(resolve, 100));
      document.removeEventListener('securitypolicyviolation', receive);
      script.remove(); image.remove();
      return { blocked, executed: Reflect.get(globalThis, 'cspExecuted'), violations };
    }, target);
    assert.equal(result.blocked, true);
    assert.equal(result.executed, undefined);
    for (const directive of ['connect-src', 'img-src', 'script-src-elem']) assert(result.violations.includes(directive), directive);
    assert.equal(hits, 0, 'the local HTTP listener must receive no request');
    assert(requests.every(url => url === target), 'only intentional CSP probes may be attempted');
    assert.deepEqual(responses, [], 'renderer received no HTTP response');
  });

  await check('stopping active work reaps the child and preserves the next draft', async () => {
    const pid = await latestPid();
    process.kill(pid, 'SIGSTOP');
    await window.locator('#question').fill('Stop this active request');
    await window.locator('#send').click();
    await window.locator('#operation').filter({ hasText: /^处理中/ }).waitFor();
    await window.locator('#question').fill('停止后保留的草稿');
    await window.locator('#stop').click();
    await window.locator('#connection').filter({ hasText: /^Pi 已停止$/ }).waitFor();
    await untilDead(pid);
    assert.equal(await window.locator('#question').inputValue(), '停止后保留的草稿');
    assert.equal(await window.locator('#send').isDisabled(), true);
    assert.match(await window.locator('#error').innerText(), /^错误：.*Pi stopped/);
    assert.equal(await window.locator('#restart').isEnabled(), true);
  });

  await check('explicit restart creates a fresh child without clearing an unsent draft', async () => {
    const old = await latestPid();
    await window.locator('#restart').click();
    await ready(window);
    assert.notEqual(await latestPid(), old);
    assert.equal(alive(old), false);
    assert.equal(await window.locator('#transcript .message').count(), 0);
    assert.equal(await window.locator('#tools .tool').count(), 0);
    assert.equal(await window.locator('#question').inputValue(), '停止后保留的草稿');
    assert.equal(await window.locator('#error').isVisible(), false);
  });

  await check('a rejected form submission restores its draft without dispatching to Pi', async () => {
    const invalid = 'x'.repeat(16001);
    const before = (await records()).filter(record => record.type === 'prompt').length;
    await window.locator('#question').evaluate((element, value) => {
      if (!(element instanceof HTMLTextAreaElement)) throw new Error('Missing question input.');
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, invalid);
    await window.locator('#send').click();
    await window.locator('#error').filter({ hasText: '错误：Invalid text.' }).waitFor();
    assert.equal(await window.locator('#question').inputValue(), invalid);
    assert.equal((await records()).filter(record => record.type === 'prompt').length, before);
    await window.locator('#question').fill('崩溃时保留的草稿');
  });

  await check('Pi crash becomes a visible failure and restart never happens implicitly', async () => {
    const pid = await latestPid();
    const launches = (await records()).filter(record => record.type === 'launch').length;
    process.kill(pid, 'SIGKILL');
    await window.locator('#connection').filter({ hasText: /^Pi 运行失败$/ }).waitFor();
    await untilDead(pid);
    assert.equal(await window.locator('#send').isDisabled(), true);
    assert.equal(await window.locator('#restart').isEnabled(), true);
    assert.equal(await window.locator('#error').isVisible(), true);
    assert.equal(await window.locator('#question').inputValue(), '崩溃时保留的草稿');
    assert.equal((await records()).filter(record => record.type === 'launch').length, launches);
    await window.locator('#restart').click();
    await ready(window);
    assert.notEqual(await latestPid(), pid);
  });

  await check('restarted Pi still executes hello through the real extension', async () => {
    await window.locator('#question').fill('Check after crash');
    await window.locator('#send').click();
    await window.locator('#tools .tool.succeeded').waitFor();
    await window.waitForFunction(async () => (await globalThis.optionAgent.view()).operation.kind === 'idle');
    assert.equal(await window.locator('#transcript .assistant .message-text').last().innerText(), 'Hello, Sean! Advice only.');
    assert.deepEqual(pageErrors, []);
    await window.screenshot({ path: join(artifacts, 'electron-smoke.png'), fullPage: true });
  });

  await check('navigation and popups cannot open another origin or window', async () => {
    const original = window.url();
    await window.evaluate(target => {
      const link = document.createElement('a'); link.href = target; document.body.append(link); link.click(); link.remove();
      globalThis.open(target);
    }, target);
    await Bun.sleep(100);
    assert.equal(window.url(), original);
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    assert.equal(hits, 0);
  });

  await check('closing the real window aborts and reaps all fake-pi processes', async () => {
    const pid = await latestPid();
    const exited = new Promise<void>(resolve => desktop.process().once('exit', () => resolve()));
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await Promise.race([exited, Bun.sleep(10000).then(() => { throw new Error('Electron close timed out.'); })]);
    await untilDead(pid);
    const log = await records();
    assert(log.some(record => record.type === 'abort'), 'closing sends abort over RPC');
    for (const launched of pids) assert.equal(alive(launched), false, `no orphan fake-pi ${launched}`);
    assert.equal(hits, 0);
    assert.deepEqual(pageErrors, []);
  });

  await check('renderer crash shuts down Electron and reaps its live Pi child', async () => {
    application = await electron.launch({
      executablePath: join(app, 'node_modules/.bin/electron'),
      args: [app, `--user-data-dir=${join(root, 'crash-profile')}`], env,
      timeout: 20000,
    });
    electronProcess = application.process();
    electronProcess.stderr?.on('data', chunk => diagnostics.push(String(chunk)));
    page = await application.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
    page.on('response', response => { if (/^https?:/.test(response.url())) responses.push(response.url()); });
    await ready(page);
    const pid = await latestPid();
    const exited = new Promise<void>(resolve => electronProcess?.once('exit', () => resolve()));
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer());
    await Promise.race([exited, Bun.sleep(10000).then(() => { throw new Error('Renderer-crash cleanup timed out.'); })]);
    await untilDead(pid);
    await records();
    for (const launched of pids) assert.equal(alive(launched), false, `no orphan after renderer crash ${launched}`);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(responses, []);
    assert(requests.every(url => url === target));
    assert.equal(hits, 0);
  });
} catch (error) {
  failure = error;
  assertions.push({ name: current, status: 'failed', error: error instanceof Error ? error.message : String(error) });
  if (page && !page.isClosed()) await page.screenshot({ path: join(artifacts, 'electron-smoke.failure.png'), fullPage: true }).catch(() => {});
} finally {
  if (application && electronProcess?.exitCode === null) await application.close().catch(() => {});
  if (await Bun.file(logPath).exists()) {
    await records();
    await writeFile(join(artifacts, 'electron-smoke.fake-pi.jsonl'), await readFile(logPath));
  }
  for (const pid of pids) {
    if (alive(pid)) {
      process.kill(pid, 'SIGKILL');
      failure ??= new Error(`Smoke cleanup found orphan fake-pi ${pid}.`);
    }
  }
  server.stop(true);
  await mkdir(artifacts, { recursive: true });
  if (!failure) await rm(join(artifacts, 'electron-smoke.failure.png'), { force: true });
  await writeFile(join(artifacts, 'electron-smoke.assertions.json'), `${JSON.stringify({
    status: failure ? 'failed' : 'passed', timestamp: new Date().toISOString(),
    runtime: {
      electron: 'real', pi: 'tests/fake-pi.ts',
      modelCalls: runtimeEvidence[0]?.piExecutable === fake ? 0 : null,
      modelCallEvidence: 'Explicit fake-pi executable, not a real provider client.',
      isolatedProfile: runtimeEvidence[0]?.userData === join(root, 'profile') && runtimeEvidence[0]?.piDirectory === join(root, 'pi-agent'),
      inheritedCredentials: runtimeEvidence[0] ? runtimeEvidence[0].credentialVariableNames.length > 0 : null,
      evidence: runtimeEvidence[0] ?? null,
    },
    assertions, pageErrors, rendererHttpAttempts: requests, rendererHttpResponses: responses, networkHits: hits, childPids: [...pids],
  }, null, 2)}\n`);
  await writeFile(join(artifacts, 'electron-smoke.stderr.log'), diagnostics.join(''));
  await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
process.stdout.write(`Electron smoke passed. ${assertions.length} assertions. Artifacts in artifacts/electron-smoke.*\n`);
