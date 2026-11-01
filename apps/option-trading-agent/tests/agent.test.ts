import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import optionAgent, { type ExtensionContext, type OptionExtensionAPI } from '../extensions/option-agent/index.ts';
import { loadConfig, type Config } from '../src/agent/config.ts';
import { PiDriver } from '../src/agent/driver.ts';
import { JsonlDecoder, type RpcRecord } from '../src/agent/jsonl.ts';
import { PiProcess } from '../src/agent/rpc.ts';
import { AGENT_LIMITS, parseHello, parseMarketRequest, parseMarketResult, type AgentView } from '../src/business/types.ts';

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

function extension() {
  const hooks = new Map<string, Parameters<OptionExtensionAPI['on']>[1]>();
  const commands = new Map<string, Parameters<OptionExtensionAPI['registerCommand']>[1]>();
  const tools = new Map<string, Parameters<OptionExtensionAPI['registerTool']>[0]>();
  const entries: { customType: string; data: unknown }[] = [];
  let aborted = false;
  let shutdown = false;
  const ctx: ExtensionContext = { cwd: app, model: { provider: 'openai-codex', id: 'gpt-6.1-sol' },
    abort() { aborted = true; }, shutdown() { shutdown = true; } };
  optionAgent({ registerTool(tool) { tools.set(tool.name, tool); }, registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { hooks.set(name, handler); }, appendEntry(customType, data) { entries.push({ customType, data }); } });
  return { ctx, commands, tools, entries, get aborted() { return aborted; }, get shutdown() { return shutdown; },
    hook(name: string, event: RpcRecord = {}) { return hooks.get(name)?.(event, ctx); } };
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
  test('native read rejects traversal, external files and symlinks before execution', async () => {
    const fixture = extension();
    const link = join(app, 'skills', `test-link-${crypto.randomUUID()}.md`);
    await symlink(join(app, 'skills/option-coach/SKILL.md'), link);
    try {
      expect(await fixture.hook('tool_call', { toolName: 'read', input: { path: join(app, 'skills/option-coach/SKILL.md') } })).toBeUndefined();
      for (const path of [join(app, 'package.json'), 'skills/../package.json', 'skills/option-coach/../option-coach/SKILL.md', 'skills/missing.md', link, 'skills', 4]) {
        expect(await fixture.hook('tool_call', { toolName: 'read', input: { path } })).toMatchObject({ block: true });
      }
      for (const toolName of ['bash', 'write', 'edit', 'codemode', 'unknown']) expect(await fixture.hook('tool_call', { toolName, input: {} })).toMatchObject({ block: true });
    } finally { await rm(link); }
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
      expect(driver.view().tools).toEqual([{ id: 'hello-1', name: 'hello', input: { name: 'Sean' }, kind: 'succeeded', text: 'Hello, Sean!', hello: { kind: 'hello', name: 'Sean', greeting: 'Hello, Sean!', adviceOnly: true } }]);
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
  test.each(['agent-end-only', 'command-wrong-id'])('%s hits the operation deadline visibly', async mode => {
    await using(mode, async driver => {
      const pending = mode === 'agent-end-only' ? driver.ask('hello') : driver.command({ action: 'echo', text: 'test' });
      await expect(pending).rejects.toThrow('timed out');
      expect(driver.view().connection).toEqual({ kind: 'failed', error: 'Pi operation timed out.' });
    }, 120);
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
      expect(parseMarketResult(entry ? Object(entry.entry).data : null)).toEqual({ requestId: 'bad', status: 'error', error: 'Invalid Stage 0 echo request.' });
      expect(events.some(record => record.type === 'turn_start')).toBe(false);
      const log = records(await readFile(logPath, 'utf8'));
      expect(log.some(record => record.type === 'turn_start' || record.type === 'hook')).toBe(false);
    } finally { await child.stop(); await rm(root, { recursive: true, force: true }); }
  });
});
