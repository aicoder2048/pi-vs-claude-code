#!/usr/bin/env bun
import { appendFileSync, closeSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import optionAgent, { type ExtensionContext, type OptionExtensionAPI } from '../extensions/option-agent/index.ts';
import { JsonlDecoder, type RpcRecord } from '../src/agent/jsonl.ts';
import { MarketData } from '../src/business/market-data/client.ts';
import { normalizeContract, normalizeOptionChain } from '../src/business/market-data/normalize.ts';
import { parseMarketResult, parseMarketToolResult } from '../src/business/market-data/protocol.ts';
import { object, type OptionChainQuery } from '../src/business/types.ts';
import bars from './fixtures/market/daily-bars.json';
import chain from './fixtures/market/option-chain.json';
import callsBeforePuts from './fixtures/market/calls-before-puts.ts';
import contract from './fixtures/market/contract.json';
import holidays from './fixtures/market/holidays.json';
import treasury from './fixtures/market/treasury.json';

const mode = process.env.OPTION_AGENT_FAKE_MODE ?? process.env.FAKE_PI_MODE ?? 'valid';
const emit = (record: RpcRecord): void => { process.stdout.write(`${JSON.stringify(record)}\n`); };
const log = (record: RpcRecord): void => {
  if (process.env.OPTION_AGENT_FAKE_LOG) appendFileSync(process.env.OPTION_AGENT_FAKE_LOG, `${JSON.stringify(record)}\n`);
};
const response = (record: RpcRecord, data?: unknown): void => {
  emit({ type: 'response', id: record.id, command: record.type, success: true, data });
};
const cacheDir = mkdtempSync(join(tmpdir(), 'option-fake-pi-'));
process.on('exit', () => rmSync(cacheDir, { recursive: true, force: true }));
const occ = 'O:NIMB261106P00100000';
const sideCase = /^(?:market|command)-side-(put|call|omitted)(?:-as-(put|call|omitted))?$/.exec(mode);
const chainQuery: OptionChainQuery = { symbol: 'NIMB', expiry: '2026-11-06',
  ...(sideCase?.[1] === 'put' || sideCase?.[1] === 'call' ? { side: sideCase[1] } : {}),
  strikeRange: { min: 100, max: sideCase ? 111 : 105 } };
const marketCalls = [
  { name: 'get_daily_bars', input: { symbol: 'NIMB', days: 4 } },
  { name: 'get_option_chain', input: chainQuery },
  { name: 'get_contract', input: { occ } },
];
const withoutQuotes = (row: Record<string, unknown>) => ({
  ...row, last_quote: null, implied_volatility: null, greeks: {}, open_interest: null, day: { volume: null },
});
const marketData = new MarketData({
  cacheDir, now: () => Date.parse('2026-10-30T20:05:00.000Z'), getApiKey: () => 'fixture-only-token',
  async fetch(input) {
    const url = new URL(input);
    if (url.origin !== 'https://api.polygon.io') throw new Error('Unknown fixture host.');
    let value: unknown;
    if (/^\/v2\/aggs\/ticker\/NIMB\/range\/1\/day\/\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}$/.test(url.pathname)) value = bars;
    else if (url.pathname === '/v3/snapshot/options/NIMB') value = sideCase ? callsBeforePuts
      : mode === 'market-partial' ? { ...chain, results: chain.results.map(withoutQuotes) } : chain;
    else if (url.pathname === `/v3/snapshot/options/NIMB/${occ}`) value = mode === 'market-partial' ? { ...contract, results: withoutQuotes(contract.results) } : contract;
    else if (url.pathname === '/v1/marketstatus/upcoming') value = holidays;
    else if (url.pathname === '/fed/v1/treasury-yields') value = treasury;
    else throw new Error(`Unknown fixture URL ${url.pathname}`);
    log({ type: 'fixture_fetch', path: url.pathname, search: url.search });
    return new Response(JSON.stringify(mode === 'market-unavailable' ? { status: 'NOT_AUTHORIZED' } : value), {
      status: mode === 'market-unavailable' ? 403 : 200,
    });
  },
});
const dialogs = new Map<string, RpcRecord>();
const commands = new Map<string, Parameters<OptionExtensionAPI['registerCommand']>[1]>();
const tools = new Map<string, Parameters<OptionExtensionAPI['registerTool']>[0]>();
const hooks = new Map<string, ((event: RpcRecord, ctx: ExtensionContext) => unknown)[]>();
const selected = process.argv[process.argv.indexOf('--model') + 1] ?? 'openai-codex/gpt-6.1-sol';
const slash = selected.indexOf('/');
let model: ExtensionContext['model'] = { provider: selected.slice(0, slash), id: selected.slice(slash + 1) };
if (mode === 'wrong-model') model = { provider: 'openai-codex', id: 'wrong-model' };
if (mode === 'anthropic-model') model = { provider: 'openrouter', id: 'anthropic/claude' };
if (mode === 'no-model') model = undefined;
let aborted = false;
const ctx: ExtensionContext = { cwd: process.cwd(), get model() { return model; }, abort() { aborted = true; }, shutdown() { aborted = true; } };
optionAgent({
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand(name, command) { commands.set(name, command); },
  on(event, handler) { hooks.set(event, [...hooks.get(event) ?? [], handler]); },
  appendEntry(customType, data) {
    let entry = { type: 'custom', customType, data };
    const payload = object(data);
    if (mode === 'command-wrong-id' && customType === 'option-market-result/v1') entry = { ...entry, data: { ...payload, requestId: 'stale-id' } };
    if (mode === 'command-malformed' && customType === 'option-market-result/v1') entry = { ...entry, data: { ...payload, status: 'bogus' } };
    if (mode === 'command-wrong-action' && customType === 'option-market-result/v1') entry = { ...entry, data: { requestId: payload.requestId, status: 'ok', action: 'echo', text: 'wrong action', marker: 'option-agent', stage: 0 } };
    if (mode === 'command-query-mismatch' && customType === 'option-market-result/v1') {
      const result = parseMarketResult(data);
      if (result.status !== 'ok' || result.action !== 'market') throw new Error('Expected a market panel fixture.');
      entry = { ...entry, data: { ...result, panel: { ...result.panel,
        query: { ...result.panel.query, days: 3 }, bars: { ...result.panel.bars, rows: result.panel.bars.rows.slice(-3) } } } };
    }
    if (mode.startsWith('command-side-') && sideCase?.[2] && customType === 'option-market-result/v1') {
      const result = parseMarketResult(data);
      if (result.status !== 'ok' || result.action !== 'market') throw new Error('Expected a market panel fixture.');
      const query = { ...result.panel.query };
      delete query.side;
      if (sideCase[2] === 'put' || sideCase[2] === 'call') query.side = sideCase[2];
      entry = { ...entry, data: parseMarketResult({ ...result, panel: { ...result.panel, query,
        chain: normalizeOptionChain(callsBeforePuts, query, { fetchedAt: result.panel.chain.fetchedAt, source: 'network' }) } }) };
      log({ type: 'validated_fault', boundary: 'command', mode });
    }
    if (mode === 'command-wrong-contract' && customType === 'option-market-result/v1') {
      const result = parseMarketResult(data);
      if (result.status !== 'ok' || result.action !== 'contract') throw new Error('Expected a contract fixture.');
      const otherOcc = 'O:NIMB261106C00105000';
      entry = { ...entry, data: { ...result, occ: otherOcc,
        result: normalizeContract({ status: 'OK', results: chain.results[1] }, { occ: otherOcc }, {
          fetchedAt: result.result.fetchedAt, source: result.result.source,
        }) } };
    }
    if (['command-query-mismatch', 'command-wrong-contract'].includes(mode) && customType === 'option-market-result/v1') {
      entry = { ...entry, data: parseMarketResult(entry.data) };
      log({ type: 'validated_fault', boundary: 'command', mode });
    }
    const send = () => {
      log({ type: 'command_entry', requestId: object(entry.data).requestId });
      emit({ type: 'entry_appended', entry });
      if (mode === 'command-duplicate-entry') emit({ type: 'entry_appended', entry });
    };
    if (mode === 'command-entry-late') setTimeout(send, 60); else send();
  },
}, { marketData });

async function hook(type: string, event: RpcRecord = {}): Promise<unknown> {
  let result: unknown;
  for (const handler of hooks.get(type) ?? []) {
    log({ type: 'hook', event: type });
    try { result = await handler({ type, ...event }, ctx); }
    catch (error) {
      emit({ type: 'extension_error', event: type, error: error instanceof Error ? error.message : 'Extension failed.' });
      throw error;
    }
  }
  return result;
}

function resources(): RpcRecord[] {
  const registered = [...commands].map(([name, command]) => ({ name, description: command.description, source: 'extension' }));
  const skills = join(process.cwd(), 'skills');
  for (const directory of readdirSync(skills)) {
    const text = readFileSync(join(skills, directory, 'SKILL.md'), 'utf8');
    const name = /^name: (.+)$/m.exec(text)?.[1];
    if (name) registered.push({ name: `skill:${name}`, description: '', source: 'skill' });
  }
  return registered.filter(command => !(mode === 'missing-marker' && command.name === 'option-agent') && !(mode === 'missing-skills' && command.source === 'skill') && !(mode === 'missing-command' && command.name === 'option-market'));
}

let callSequence = 0;
async function prompt(record: RpcRecord): Promise<void> {
  if (typeof record.message !== 'string') throw new Error('Prompt requires text.');
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(record.message);
  const command = match ? commands.get(match[1]) : undefined;
  if (command) {
    if (mode === 'command-turn-start') { emit({ type: 'turn_start' }); log({ type: 'turn_start' }); }
    if (mode === 'command-slow-ack') await Bun.sleep(350);
    await command.handler(match?.[2] ?? '', ctx);
    if (mode === 'command-slow-ack') await Bun.sleep(80);
    const ack = mode === 'command-missing-disposition' ? {} : {
      disposition: mode === 'command-started' ? 'started' : mode === 'command-queued' ? 'queued' : 'handled',
    };
    log({ type: 'command_ack', ...ack });
    response(record, ack);
    return;
  }
  aborted = false;
  await hook('input', { text: record.message, source: 'rpc' });
  const disposition = ['queued', 'handled', 'missing-disposition'].includes(mode) ? mode : 'started';
  const ack = () => response(record, mode === 'missing-disposition' ? {} : { disposition: mode === 'late-bad-ack' ? 'handled' : disposition });
  if (mode !== 'late-ack' && mode !== 'late-bad-ack') ack();
  emit({ type: 'agent_start' });
  if (mode === 'turn-model-switch') model = { provider: 'anthropic', id: 'claude' };
  const turns = mode === 'turn-budget' ? 13 : mode === 'at-limit' ? 12 : 1;
  for (let turn = 0; turn < turns; turn++) {
    try { await hook('turn_start'); } catch { return; }
    if (aborted) return;
    emit({ type: 'turn_start' });
    log({ type: 'turn_start' });
  }
  emit({ type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Transport ' } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'check.' } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Transport check.' } });
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Transport check.' }], stopReason: 'toolUse' } });
  let greeting = '';
  const count = mode.startsWith('market-') ? marketCalls.length : mode === 'tool-budget' ? 25 : mode === 'at-limit' ? 24 : 1;
  for (let index = 0; index < count; index++) {
    const marketCall = mode.startsWith('market-') ? marketCalls[index] : undefined;
    const toolName = marketCall?.name ?? (mode === 'forbidden-tool' ? 'bash' : mode.startsWith('read-') ? 'read' : 'hello');
    const toolCallId = `${marketCall ? toolName : 'hello'}-${++callSequence}`;
    const path = mode === 'read-outside' ? join(process.cwd(), 'package.json') : mode === 'read-traversal' ? 'skills/../package.json' : mode === 'read-symlink' ? 'skills/linked.md' : 'skills/option-coach/SKILL.md';
    const input = marketCall?.input ?? (toolName === 'read' ? { path } : { name: 'Sean' });
    emit({ type: 'tool_execution_start', toolCallId, toolName, args: input });
    const gate = await hook('tool_call', { toolCallId, toolName, input });
    let result: unknown;
    let isError = false;
    try {
      if (gate && typeof gate === 'object' && 'block' in gate && gate.block) throw new Error('reason' in gate ? String(gate.reason) : 'Blocked.');
      if (toolName === 'read') result = { content: [{ type: 'text', text: readFileSync(path, 'utf8') }], details: {} };
      else {
        const tool = tools.get(toolName);
        if (!tool) throw new Error('Unknown tool.');
        const executed = await tool.execute(toolCallId, input, undefined, undefined, ctx);
        if (executed.details.kind === 'hello') greeting = executed.details.greeting;
        result = executed;
        if (mode.startsWith('market-side-') && sideCase?.[2] && toolName === 'get_option_chain') {
          const query = { ...chainQuery };
          delete query.side;
          if (sideCase[2] === 'put' || sideCase[2] === 'call') query.side = sideCase[2];
          const alternative = await tool.execute('alternative-side', query, undefined, undefined, ctx);
          result = { ...executed, details: parseMarketToolResult(alternative.details) };
          log({ type: 'validated_fault', boundary: 'tool', mode });
        }
        if (marketCall && index === 0) {
          if (mode === 'market-tool-malformed') result = { ...executed, details: { kind: 'dailyBars', query: input, result: { status: 'ok', rows: [] } } };
          if (mode === 'market-tool-query-mismatch') {
            const details = parseMarketToolResult(executed.details);
            if (details.kind !== 'dailyBars') throw new Error('Expected daily bars fixture.');
            result = { ...executed, details: parseMarketToolResult({ ...details,
              query: { ...details.query, days: 3 }, result: { ...details.result, rows: details.result.rows.slice(-3) } }) };
            log({ type: 'validated_fault', boundary: 'tool', mode });
          }
          if (mode === 'market-tool-wrong-kind') {
            const alternative = await tools.get('get_option_chain')?.execute('alternative-chain', chainQuery, undefined, undefined, ctx);
            result = { ...executed, details: parseMarketToolResult(alternative?.details) };
            log({ type: 'validated_fault', boundary: 'tool', mode });
          }
          if (mode === 'market-tool-wrong-row') {
            const details = executed.details;
            if (details.kind === 'dailyBars') result = { ...executed, details: { ...details, result: { ...details.result, rows: details.result.rows.map(row => ({ ...row, symbol: 'OTHER' })) } } };
          }
        }
      }
    } catch (error) {
      isError = true;
      result = { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Tool failed.' }], details: {} };
    }
    await hook('tool_result', { toolCallId, toolName, input, result, isError });
    emit({ type: 'tool_execution_end', toolCallId, toolName, result, isError });
    if (mode === 'duplicate-tool-end') emit({ type: 'tool_execution_end', toolCallId, toolName, result, isError });
  }
  if (mode === 'protocol-failure') { process.stdout.write('{bad}\n'); return; }
  if (mode === 'bad-text') { emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 9 } }); return; }
  emit({ type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } });
  const text = `${greeting || (mode.startsWith('market-') ? 'Fixture market data retrieved.' : 'Skill read.')} Advice only.`;
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: mode === 'provider-failure' ? 'error' : 'stop', errorMessage: mode === 'provider-failure' ? 'Offline provider failure.' : undefined } });
  await hook('agent_end');
  emit({ type: 'agent_end', messages: [], willRetry: false });
  if (mode === 'agent-end-only') return;
  if (mode === 'delayed-settle') await Bun.sleep(100);
  await hook('agent_settled');
  emit({ type: 'agent_settled', aborted: mode === 'aborted' });
  if (mode === 'late-ack' || mode === 'late-bad-ack') { await Bun.sleep(50); ack(); }
}
log({ type: 'launch', pid: process.pid, args: process.argv.slice(2) });

async function handle(record: RpcRecord): Promise<void> {
  log(record);
  if (mode === 'hang' || mode === 'stdout-eof' || record.type === 'hang') return;
  if (record.type === 'extension_ui_response') {
    const pending = typeof record.id === 'string' ? dialogs.get(record.id) : undefined;
    if (pending) { dialogs.delete(String(record.id)); response(pending, { cancelled: record.cancelled }); }
    return;
  }
  switch (record.type) {
    case 'abort':
      if (mode !== 'ignore-term') response(record);
      return;
    case 'slow':
      await Bun.sleep(100);
      response(record);
      return;
    case 'prompt':
      await prompt(record);
      return;
    case 'set_auto_retry': case 'set_auto_compaction':
      response(record);
      return;
    case 'get_commands':
      response(record, mode === 'bad-resources' ? { commands: [null] } : { commands: resources() });
      return;
    case 'get_state':
      response(record, { model, isStreaming: mode === 'startup-busy' });
      return;
    case 'echo':
      response(record, { text: record.text });
      return;
    case 'env-check':
      response(record, {
        polygon: Object.hasOwn(process.env, 'POLYGON_API_KEY'),
        envFile: Object.hasOwn(process.env, 'MARKET_DATA_ENV_FILE'),
        offline: process.env.PI_OFFLINE, telemetry: process.env.PI_TELEMETRY,
      });
      return;
    case 'stale-response':
      emit({ type: 'response', id: 'stale-id', command: 'other', success: true });
      response(record);
      response(record);
      return;
    case 'bad-command':
      emit({ type: 'response', id: record.id, command: 'wrong-command', success: true });
      return;
    case 'bad-success':
      emit({ type: 'response', id: record.id, command: record.type, success: 'true' });
      return;
    case 'uncorrelated-error':
      emit({ type: 'response', command: 'parse', success: false, error: 'Uncorrelated rejection.' });
      return;
    case 'fail':
      emit({ type: 'response', id: record.id, command: record.type, success: false, error: 'Expected rejection.' });
      return;
    case 'crash':
      process.stderr.write('fake crash diagnostic\n');
      process.exit(7);
    case 'malformed': process.stdout.write('{bad-json}\n'); return;
    case 'invalid-object': process.stdout.write('[]\n'); return;
    case 'missing-type': process.stdout.write('{}\n'); return;
    case 'partial': process.stdout.write('{"type":'); process.exit(2);
    case 'invalid-utf8': process.stdout.write(Buffer.from([0xff, 10])); return;
    case 'oversize': process.stdout.write('x'.repeat(1048577)); return;
    case 'ui': {
      const id = `ui-${record.id}`;
      dialogs.set(id, record);
      emit({ type: 'extension_ui_request', id, method: record.method, title: 'Offline dialog' });
      return;
    }
    case 'notify':
      emit({ type: 'extension_ui_request', id: 'notice', method: 'notify', message: 'Offline notification' });
      response(record);
      return;
    default:
      emit({ type: 'response', id: record.id, command: record.type, success: false, error: 'Unknown command.' });
  }
}

if (mode === 'ignore-term' || mode === 'stdout-eof') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
if (mode === 'stdout-eof') closeSync(1);
const decoder = new JsonlDecoder(record => {
  void handle(record).catch(() => { process.stderr.write('fake handler failed\n'); process.exit(8); });
});
process.stdin.on('data', (chunk: Buffer) => decoder.push(chunk));
process.stdin.on('end', () => {
  rmSync(cacheDir, { recursive: true, force: true });
  if (mode !== 'ignore-term' && mode !== 'stdout-eof') process.exit(0);
});
if (mode === 'slow-read') { process.stdin.pause(); setTimeout(() => process.stdin.resume(), 150); }
