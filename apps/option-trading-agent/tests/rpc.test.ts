import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertModel, childEnv, loadConfig, OPTION_AGENT_TOOLS, piArgs, type Config } from '../src/agent/config.ts';
import { JsonlDecoder, type RpcRecord } from '../src/agent/jsonl.ts';
import { PiProcess } from '../src/agent/rpc.ts';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fake = join(app, 'tests/fake-pi.ts');
function config(mode = 'valid'): Config {
  return loadConfig(app, {
    PATH: process.env.PATH,
    OPTION_AGENT_PI_BIN: fake,
    OPTION_AGENT_FAKE_MODE: mode,
    OPTION_AGENT_REQUEST_TIMEOUT_MS: '2000',
    OPTION_AGENT_SHUTDOWN_GRACE_MS: '40',
  });
}
function records(text: string): RpcRecord[] {
  const result: RpcRecord[] = [];
  const decoder = new JsonlDecoder(record => result.push(record));
  decoder.push(Buffer.from(text)); decoder.end();
  return result;
}
async function logged(run: (c: Config, logPath: string) => Promise<void>, mode = 'valid'): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'option-rpc-'));
  try {
    const c = config(mode);
    const logPath = join(root, 'events.jsonl');
    c.env.OPTION_AGENT_FAKE_LOG = logPath;
    await run(c, logPath);
  } finally { await rm(root, { recursive: true, force: true }); }
}
function pidFrom(log: RpcRecord[]): number {
  const pid = log.find(record => record.type === 'launch')?.pid;
  if (typeof pid !== 'number') throw new Error('Missing fixture PID.');
  return pid;
}

describe('bounded LF JSONL decoder', () => {
  test('every byte boundary preserves UTF-8, CRLF and Unicode separators', () => {
    const bytes = Buffer.from('{"text":"中文😀\u2028next\u2029line"}\r\n\n{"ok":true}\n');
    for (let split = 0; split <= bytes.length; split++) {
      const result: RpcRecord[] = [];
      const decoder = new JsonlDecoder(record => result.push(record));
      decoder.push(bytes.subarray(0, split)); decoder.push(bytes.subarray(split)); decoder.end();
      expect(result).toEqual([{ text: '中文😀\u2028next\u2029line' }, { ok: true }]);
    }
    const result: RpcRecord[] = [];
    const decoder = new JsonlDecoder(record => result.push(record));
    for (const byte of bytes) decoder.push(Uint8Array.of(byte));
    decoder.end();
    expect(result).toHaveLength(2);
  });
  test.each(['[]\n', 'null\n', 'false\n', '1\n', '"x"\n', 'oops\n', '{}{}\n', '{} trailing\n', '\ufeff{}\n'])('rejects non-object or bad JSON %j', text => {
    expect(() => records(text)).toThrow();
  });
  test('rejects invalid UTF-8, including split and truncated sequences', () => {
    for (const invalid of [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe4, 0xb8]]) {
      const decoder = new JsonlDecoder(() => {});
      decoder.push(Buffer.from('{"text":"'));
      for (const byte of invalid) decoder.push(Uint8Array.of(byte));
      expect(() => decoder.push(Buffer.from('"}\n'))).toThrow('UTF-8');
    }
  });
  test('enforces byte limits per record, across chunks, not across a batch', () => {
    const decoder = new JsonlDecoder(() => {}, 2);
    decoder.push(Buffer.from('{}\n{}\n')); decoder.end();
    const oversized = new JsonlDecoder(() => {}, 3);
    oversized.push(Buffer.from('{'));
    expect(() => oversized.push(Buffer.from('123'))).toThrow('limit');
    expect(() => new JsonlDecoder(() => {}, 8).push(Buffer.from('{"中":1}\n'))).toThrow('limit');
    expect(() => new JsonlDecoder(() => {}, 0)).toThrow();
  });
  test('rejects even valid objects or whitespace without a trailing LF', () => {
    for (const text of ['{}', '{"text":"ok"}', ' ', '{}\n{}', '\r']) {
      const decoder = new JsonlDecoder(() => {}); decoder.push(Buffer.from(text));
      expect(() => decoder.end()).toThrow('unterminated');
    }
  });
});

describe('isolated launch config', () => {
  test('uses Codex, explicit resources and only the centralized read-only tools', () => {
    const c = loadConfig(app, {});
    expect(c.model).toBe('openai-codex/gpt-6.1-sol'); expect(c.piBin).toBe('pi');
    const args = piArgs(c);
    for (const flag of ['--no-extensions', '--no-skills', '--no-session', '--no-context-files', '--no-prompt-templates', '--no-mcp', '--offline', '--no-approve', '--no-themes']) expect(args).toContain(flag);
    expect(args[args.indexOf('--mode') + 1]).toBe('rpc');
    expect(args[args.indexOf('-e') + 1]).toBe(join(app, 'extensions/option-agent'));
    expect(args[args.indexOf('--skill') + 1]).toBe(join(app, 'skills'));
    expect(OPTION_AGENT_TOOLS).toEqual(['read', 'hello', 'get_daily_bars', 'get_option_chain', 'get_contract']);
    expect(args[args.indexOf('--tools') + 1]).toBe('read,hello,get_daily_bars,get_option_chain,get_contract');
    expect(args[args.indexOf('--system-prompt') + 1]).toContain('advice only');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('');
    expect(args).not.toContain('--session');
  });
  test.each(['anthropic/claude', 'AnThRoPiC/claude', 'openrouter/anthropic/claude', 'openrouter/AnThRoPiC/claude', 'provider/model/ANTHROPIC', 'provider/anthropic/nested/model', 'claude', '', 'provider/', 'provider//model', 'provider/model/', 'provider/null\0byte', 'provider/white space'])('rejects model %j at load and mutable use', model => {
    expect(() => loadConfig(app, { OPTION_AGENT_MODEL: model })).toThrow();
    const c = config(); c.model = model;
    expect(() => piArgs(c)).toThrow();
    expect(() => new PiProcess(c, () => {}).start()).toThrow();
  });
  test.each(['openai-codex/gpt-6.1-sol', 'openrouter/openai/model', 'provider/not-anthropic', 'provider/anthropic-compatible'])('accepts qualified model %s', model => {
    expect(() => assertModel(model)).not.toThrow();
  });
  test('does not echo rejected config values or preserve credential variables', () => {
    const secret = 'synthetic-test-value';
    try { loadConfig(app, { OPTION_AGENT_MODEL: `anthropic/${secret}` }); } catch (error) { expect(String(error)).not.toContain(secret); }
    for (const name of ['TIMEOUT_MS', 'REQUEST_TIMEOUT_MS', 'SHUTDOWN_GRACE_MS', 'MAX_LINE_BYTES']) {
      for (const value of ['0', '-1', 'NaN', '1.5', '9999999999', secret]) {
        expect(() => loadConfig(app, { [`OPTION_AGENT_${name}`]: value })).toThrow(`Invalid OPTION_AGENT_${name}.`);
      }
    }
    const c = loadConfig(app, { POLYGON_API_KEY: secret, MARKET_DATA_ENV_FILE: '/not/a/credential/path' });
    expect(c.env.POLYGON_API_KEY).toBeUndefined(); expect(c.env.MARKET_DATA_ENV_FILE).toBeUndefined();
    c.env.POLYGON_API_KEY = secret; c.env.MARKET_DATA_ENV_FILE = '/mutated';
    const env = childEnv(c, { POLYGON_API_KEY: secret, MARKET_DATA_ENV_FILE: '/extra', PI_OFFLINE: '0', PI_TELEMETRY: '1' });
    expect(env.POLYGON_API_KEY).toBeUndefined(); expect(env.MARKET_DATA_ENV_FILE).toBeUndefined();
    expect(env.PI_OFFLINE).toBe('1'); expect(env.PI_TELEMETRY).toBe('0');
    const invalid = config(); invalid.shutdownGraceMs = 10000;
    expect(() => new PiProcess(invalid, () => {}).start()).toThrow('limits');
    const badExecutable = config(); badExecutable.piBin = `${secret}\0`;
    expect(() => new PiProcess(badExecutable, () => {}).start()).toThrow('Cannot start Pi executable.');
  });
});

describe('actual subprocess pipes', () => {
  test('matches out-of-order ACKs by ID and command, ignores stale successes', async () => {
    const events: RpcRecord[] = [];
    const child = new PiProcess(config(), record => events.push(record)); child.start();
    try {
      const order: string[] = [];
      const slow = child.request({ type: 'slow', id: 'caller-id' }).then(record => { order.push('slow'); return record; });
      const fast = child.request({ type: 'get_commands' }).then(record => { order.push('fast'); return record; });
      const [a, b] = await Promise.all([slow, fast]);
      expect(order).toEqual(['fast', 'slow']); expect(a.command).toBe('slow'); expect(b.command).toBe('get_commands');
      expect(a.id).not.toBe(b.id); expect(a.id).not.toBe('caller-id');
      expect((await child.request({ type: 'stale-response' })).command).toBe('stale-response');
      await expect(child.request({ type: 'fail' })).rejects.toThrow('Expected rejection');
      await expect(child.request({ type: 'unknown' })).rejects.toThrow('Unknown command');
      expect((await child.request({ type: 'get_state' })).success).toBe(true);
      expect(events.some(record => record.type === 'rpc_error')).toBe(false);
    } finally { await child.stop(); }
  });
  test('serializes large writes through real pipe backpressure', async () => {
    const c = config('slow-read'); c.requestTimeoutMs = 5000;
    const child = new PiProcess(c, () => {}); child.start();
    try {
      const texts = Array.from({ length: 12 }, (_, index) => `${index}:${'中'.repeat(60000)}`);
      const replies = await Promise.all(texts.map(text => child.request({ type: 'echo', text })));
      expect(replies.map(reply => reply.data)).toEqual(texts.map(text => ({ text })));
    } finally { await child.stop(); }
  });
  test.each(['bad-command', 'bad-success', 'uncorrelated-error', 'malformed', 'invalid-object', 'missing-type', 'partial', 'invalid-utf8', 'oversize'])('fails closed on %s and rejects every pending command', async type => {
    const errors: RpcRecord[] = [];
    const child = new PiProcess(config(), record => { if (record.type === 'rpc_error') errors.push(record); }); child.start();
    try {
      const outcomes = await Promise.allSettled([child.request({ type: 'hang' }), child.request({ type })]);
      expect(outcomes.every(outcome => outcome.status === 'rejected')).toBe(true);
      expect(errors).toHaveLength(1);
      await expect(child.request({ type: 'get_state' })).rejects.toThrow();
    } finally { await child.stop(); }
  });
  test('handles missing executable and crash diagnostics without pending leaks', async () => {
    const c = config(); c.piBin = join(app, 'missing-pi-executable');
    const missing = new PiProcess(c, () => {}); missing.start();
    await expect(missing.request({ type: 'get_state' })).rejects.toThrow('Cannot start Pi'); await missing.stop();
    const child = new PiProcess(config(), () => {}); child.start();
    try {
      const outcomes = await Promise.allSettled([child.request({ type: 'hang' }), child.request({ type: 'crash' })]);
      for (const outcome of outcomes) {
        expect(outcome.status).toBe('rejected');
        if (outcome.status === 'rejected') expect(String(outcome.reason)).toContain('fake crash diagnostic');
      }
    } finally { await child.stop(); }
  });
  test('startup and active request deadlines clean up the subprocess', async () => {
    for (const mode of ['hang', 'valid']) {
      await logged(async (c, path) => {
        const child = new PiProcess(c, () => {}); child.start();
        try {
          if (mode === 'valid') await child.request({ type: 'get_state' });
          await expect(child.request({ type: mode === 'hang' ? 'get_state' : 'hang' }, 150)).rejects.toThrow('timed out');
        } finally { await child.stop(); }
        const pid = pidFrom(records(await readFile(path, 'utf8')));
        expect(() => process.kill(pid, 0)).toThrow();
      }, mode);
    }
  });
  test('rejects invalid local requests without writing them', async () => {
    const child = new PiProcess(config(), () => {});
    await expect(child.request({ type: 'get_state' })).rejects.toThrow('not connected');
    child.start();
    try {
      await expect(child.request({})).rejects.toThrow('requires a type');
      await expect(child.request({ type: '' })).rejects.toThrow('requires a type');
      await expect(child.request({ type: 'get_state' }, 0)).rejects.toThrow('timeout');
      expect(() => child.start()).toThrow('once');
      expect((await child.request({ type: 'get_state' })).success).toBe(true);
    } finally { await child.stop(); }
    expect(() => child.start()).toThrow('once');
  });
  test.each(['select', 'confirm', 'input', 'editor'])('automatically cancels extension %s dialogs with their supplied ID', async method => {
    const child = new PiProcess(config(), () => {}); child.start();
    try { expect((await child.request({ type: 'ui', method })).data).toEqual({ cancelled: true }); }
    finally { await child.stop(); }
  });
  test('does not respond to fire-and-forget UI notifications', async () => {
    await logged(async (c, path) => {
      const child = new PiProcess(c, () => {}); child.start();
      try { await child.request({ type: 'notify' }); await child.request({ type: 'get_state' }); }
      finally { await child.stop(); }
      expect(records(await readFile(path, 'utf8')).some(record => record.type === 'extension_ui_response')).toBe(false);
    });
  });
  test('strips credentials and credential paths from the actual child environment', async () => {
    const c = config(); c.env.POLYGON_API_KEY = 'synthetic-test-value'; c.env.MARKET_DATA_ENV_FILE = '/invalid';
    const child = new PiProcess(c, () => {});
    child.start({ POLYGON_API_KEY: 'synthetic-override', MARKET_DATA_ENV_FILE: '/override', PI_OFFLINE: '0' });
    try { expect((await child.request({ type: 'env-check' })).data).toEqual({ polygon: false, envFile: false, offline: '1', telemetry: '0' }); }
    finally { await child.stop(); }
  });
  test('shutdown is bounded, idempotent, sends abort and kills an EOF/TERM-ignoring process', async () => {
    await logged(async (c, path) => {
      const child = new PiProcess(c, () => {}); child.start();
      await child.request({ type: 'get_state' });
      const pending = child.request({ type: 'hang' }).catch((error: unknown) => error);
      const start = Date.now();
      const first = child.stop(); expect(child.stop()).toBe(first);
      await first; await child.stop();
      expect(Date.now() - start).toBeLessThan(1000);
      expect(String(await pending)).toContain('stopped');
      const log = records(await readFile(path, 'utf8'));
      expect(log.some(record => record.type === 'abort')).toBe(true);
      expect(() => process.kill(pidFrom(log), 0)).toThrow();
    }, 'ignore-term');
  });
  test('clean stdout EOF fails promptly and cleans up a still-running child', async () => {
    await logged(async (c, path) => {
      const child = new PiProcess(c, () => {}); child.start();
      const start = Date.now();
      await expect(child.request({ type: 'get_state' })).rejects.toThrow('stdout closed');
      await child.stop();
      expect(Date.now() - start).toBeLessThan(1000);
      const pid = pidFrom(records(await readFile(path, 'utf8')));
      expect(() => process.kill(pid, 0)).toThrow();
    }, 'stdout-eof');
  });
  test('post-start config mutation cannot change active byte, request or shutdown limits', async () => {
    await logged(async (c, path) => {
      const child = new PiProcess(c, () => {}); child.start();
      c.maxLineBytes = 1; c.requestTimeoutMs = 1; c.shutdownGraceMs = 600000;
      try { expect((await child.request({ type: 'get_state' })).success).toBe(true); }
      finally {
        const start = Date.now(); await child.stop();
        expect(Date.now() - start).toBeLessThan(1000);
      }
      const pid = pidFrom(records(await readFile(path, 'utf8')));
      expect(() => process.kill(pid, 0)).toThrow();
    }, 'ignore-term');
  });
  test('stop before start prevents spawning and remains idempotent', async () => {
    const child = new PiProcess(config(), () => {});
    const first = child.stop(); expect(child.stop()).toBe(first); await first;
    expect(() => child.start()).toThrow('once');
  });
});
