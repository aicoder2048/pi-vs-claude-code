#!/usr/bin/env bun
import { appendFileSync, closeSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import optionAgent, { type ExtensionContext, type OptionExtensionAPI } from '../extensions/option-agent/index.ts';
import { JsonlDecoder, type RpcRecord } from '../src/agent/jsonl.ts';

const mode = process.env.OPTION_AGENT_FAKE_MODE ?? process.env.FAKE_PI_MODE ?? 'valid';
const emit = (record: RpcRecord): void => { process.stdout.write(`${JSON.stringify(record)}\n`); };
const log = (record: RpcRecord): void => {
  if (process.env.OPTION_AGENT_FAKE_LOG) appendFileSync(process.env.OPTION_AGENT_FAKE_LOG, `${JSON.stringify(record)}\n`);
};
const response = (record: RpcRecord, data?: unknown): void => {
  emit({ type: 'response', id: record.id, command: record.type, success: true, data });
};
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
    if (mode === 'command-wrong-id' && customType === 'option-market-result/v1') entry = { ...entry, data: { ...Object(data), requestId: 'stale-id' } };
    if (mode === 'command-malformed' && customType === 'option-market-result/v1') entry = { ...entry, data: { requestId: 'echo-1', status: 'bogus' } };
    const send = () => emit({ type: 'entry_appended', entry });
    if (mode === 'command-entry-late') setTimeout(send, 60); else send();
  },
});

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
    await command.handler(match?.[2] ?? '', ctx);
    response(record, { disposition: mode === 'command-started' ? 'started' : 'handled' });
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
  const count = mode === 'tool-budget' ? 25 : mode === 'at-limit' ? 24 : 1;
  for (let index = 0; index < count; index++) {
    const toolCallId = `hello-${++callSequence}`;
    const toolName = mode === 'forbidden-tool' ? 'bash' : mode.startsWith('read-') ? 'read' : 'hello';
    const path = mode === 'read-outside' ? join(process.cwd(), 'package.json') : mode === 'read-traversal' ? 'skills/../package.json' : mode === 'read-symlink' ? 'skills/linked.md' : 'skills/option-coach/SKILL.md';
    const input = toolName === 'read' ? { path } : { name: 'Sean' };
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
        greeting = executed.details.greeting;
        result = executed;
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
  const text = `${greeting || 'Skill read.'} Advice only.`;
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
process.stdin.on('end', () => { if (mode !== 'ignore-term' && mode !== 'stdout-eof') process.exit(0); });
if (mode === 'slow-read') { process.stdin.pause(); setTimeout(() => process.stdin.resume(), 150); }
