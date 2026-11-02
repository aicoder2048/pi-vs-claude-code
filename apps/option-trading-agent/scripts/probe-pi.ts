import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertModel, loadConfig } from '../src/agent/config.ts';
import { PiProcess } from '../src/agent/rpc.ts';
import { REQUIRED_SKILLS, object, type MarketResult } from '../src/business/types.ts';
import { parseMarketResult } from '../src/business/market-data/protocol.ts';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(app);
if (/fake-pi/i.test(config.piBin)) throw new Error('The loader probe requires the real Pi CLI, not fake-pi.');
const request = { requestId: 'manual-pi-probe', action: 'echo', text: 'Stage 0 echo 中文\nNo market data.' };
let turns = 0;
let accept!: (result: MarketResult) => void;
let reject!: (error: Error) => void;
const entry = new Promise<MarketResult>((resolve, fail) => { accept = resolve; reject = fail; });
void entry.catch(() => {});
const child = new PiProcess(config, record => {
  try {
    if (record.type === 'turn_start') { turns++; throw new Error('Probe unexpectedly started a model turn.'); }
    if (record.type === 'rpc_error' || record.type === 'extension_error') throw new Error('Pi probe runtime failed.');
    if (record.type !== 'entry_appended') return;
    const appended = object(record.entry);
    if (appended.customType !== 'option-market-result/v1') return;
    const result = parseMarketResult(appended.data);
    if (result.requestId === request.requestId) accept(result);
  } catch (error) { reject(error instanceof Error ? error : new Error('Invalid probe event.')); void child.stop(); }
});
const timer = setTimeout(() => { reject(new Error('Pi echo probe timed out.')); void child.stop(); }, 15000);
try {
  child.start({ OPTION_AGENT_EXPECTED_MODEL: config.model });
  const commands = object((await child.request({ type: 'get_commands' })).data).commands;
  assert(Array.isArray(commands), 'Pi exposes commands');
  const parsed = commands.map(object);
  for (const [name, source] of [
    ['option-agent', 'extension'], ['option-market', 'extension'], ...REQUIRED_SKILLS.map(name => [`skill:${name}`, 'skill']),
  ]) assert(parsed.some(command => command.name === name && command.source === source), `Pi loaded ${name}`);
  const state = object((await child.request({ type: 'get_state' })).data);
  const model = object(state.model);
  const resolved = `${model.provider}/${model.id}`;
  assertModel(resolved);
  assert.equal(resolved, config.model, 'Pi resolved the requested model');
  assert.equal(state.isStreaming, false);
  const ack = await child.request({ type: 'prompt', message: `/option-market ${JSON.stringify(request)}` });
  assert.equal(object(ack.data).disposition, 'handled');
  const result = await entry;
  assert.equal(result.status, 'ok');
  assert(result.status === 'ok' && result.action === 'echo');
  assert.equal(result.text, request.text);
  assert.equal(object((await child.request({ type: 'get_state' })).data).isStreaming, false);
  assert.equal(turns, 0, 'Probe made zero model turns');
  process.stdout.write(`Pi verified. Model ${resolved}. Five resources loaded. Correlated echo handled. turn_start=${turns}.\n`);
} finally { clearTimeout(timer); await child.stop(); }
