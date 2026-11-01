import {
  AGENT_LIMITS, REQUIRED_SKILLS, boundedText, object, parseHello, parseMarketRequest, parseMarketResult,
  type AgentView, type MarketResult,
} from '../business/types.ts';
import { assertModel, type Config } from './config.ts';
import type { RpcRecord } from './jsonl.ts';
import { PiProcess } from './rpc.ts';

type Active = { id: string; ack: boolean; timer: ReturnType<typeof setTimeout>; reject(error: Error): void } & (
  | { kind: 'advice'; settled: boolean; resolve(): void; turns: number; tools: number }
  | { kind: 'command'; text: string; result: MarketResult | null; resolve(result: MarketResult): void }
);

function textContent(value: unknown): string {
  if (typeof value === 'string') return boundedText(value, 1048576);
  if (!Array.isArray(value)) throw new Error('Invalid message content.');
  return value.map(block => {
    const data = object(block);
    if (data.type === 'text') return boundedText(data.text, 1048576);
    if (typeof data.type !== 'string') throw new Error('Invalid content block.');
    return '';
  }).join('');
}

export class PiDriver {
  private state: AgentView = { connection: { kind: 'new' }, operation: { kind: 'idle' }, messages: [], tools: [] };
  private child: PiProcess | null = null;
  private active: Active | null = null;
  private sequence = 0;
  private generation = 0;
  private restarting: Promise<void> | null = null;
  private stream: { id: string; blocks: Map<number, string> } | null = null;
  private readonly listeners = new Set<(view: AgentView) => void>();
  private readonly config: Config;

  constructor(config: Config) { this.config = { ...config, env: { ...config.env } }; }

  view(): AgentView { return structuredClone(this.state); }

  subscribe(callback: (view: AgentView) => void): () => void {
    this.listeners.add(callback);
    callback(this.view());
    return () => { this.listeners.delete(callback); };
  }

  private publish(): void {
    for (const callback of this.listeners) { try { callback(this.view()); } catch {} }
  }

  async start(): Promise<void> {
    if (this.state.connection.kind !== 'new') throw new Error('Use restart() to start a fresh Pi session.');
    const generation = ++this.generation;
    const child = new PiProcess(this.config, record => {
      if (this.child !== child || ['closing', 'stopped', 'failed'].includes(this.state.connection.kind)) return;
      try { this.receive(record); } catch (error) { this.fail(error); }
    });
    this.child = child;
    this.state.connection = { kind: 'starting' };
    this.publish();
    try {
      if (generation !== this.generation || this.state.connection.kind !== 'starting') throw new Error('Pi startup was interrupted.');
      assertModel(this.config.model);
      child.start({ OPTION_AGENT_EXPECTED_MODEL: this.config.model });
      const resources = object((await child.request({ type: 'get_commands' })).data).commands;
      if (!Array.isArray(resources)) throw new Error('Invalid Pi resource list.');
      const commands = resources.map(object);
      for (const [name, source] of [
        ['option-agent', 'extension'], ['option-market', 'extension'],
        ...REQUIRED_SKILLS.map(name => [`skill:${name}`, 'skill']),
      ]) {
        if (!commands.some(command => command.name === name && command.source === source)) throw new Error(`Required Pi resource is missing: ${name}.`);
      }
      const state = object((await child.request({ type: 'get_state' })).data);
      const model = object(state.model);
      const actual = `${boundedText(model.provider, 128)}/${boundedText(model.id, 256)}`;
      assertModel(actual);
      if (actual !== this.config.model) throw new Error('Resolved Pi model does not match the requested model.');
      if (state.isStreaming !== false) throw new Error('Pi was not idle at startup.');
      await child.request({ type: 'set_auto_retry', enabled: false });
      await child.request({ type: 'set_auto_compaction', enabled: false });
      if (generation !== this.generation || this.child !== child || this.state.connection.kind !== 'starting') throw new Error('Pi startup was interrupted.');
      this.state.connection = { kind: 'ready', model: actual };
      this.publish();
    } catch (error) {
      if (generation === this.generation && this.child === child && this.state.connection.kind === 'starting') this.fail(error);
      await child.stop();
      throw error;
    }
  }

  ask(text: string): Promise<void> {
    try {
      text = boundedText(text).trim();
      if (!text) throw new Error('A question is required.');
      const child = this.available();
      const id = `advice-${++this.sequence}`;
      const promise = new Promise<void>((resolve, reject) => {
        this.active = { kind: 'advice', id, ack: false, settled: false, turns: 0, tools: 0, resolve, reject,
          timer: setTimeout(() => this.fail(new Error('Pi operation timed out.')), this.config.timeoutMs) };
      });
      this.state.messages.push({ id, role: 'user', text, status: 'complete' });
      this.state.operation = { kind: 'advice', id, turns: 0, tools: 0 };
      this.publish();
      void child.request({ type: 'prompt', message: `/skill:option-coach ${text}` }).then(ack => {
        if (this.active?.id !== id) return;
        if (object(ack.data).disposition !== 'started') throw new Error('Pi advice prompt did not start a run.');
        this.active.ack = true;
        this.complete();
      }).catch(error => { if (this.active?.id === id) this.fail(error); });
      return promise;
    } catch (error) { return Promise.reject(error); }
  }

  command(input: { action: 'echo'; text: string }): Promise<MarketResult> {
    try {
      const child = this.available();
      const request = parseMarketRequest({ ...object(input), requestId: `echo-${++this.sequence}` });
      const promise = new Promise<MarketResult>((resolve, reject) => {
        this.active = { kind: 'command', id: request.requestId, text: request.text, ack: false, result: null, resolve, reject,
          timer: setTimeout(() => this.fail(new Error('Pi operation timed out.')), this.config.timeoutMs) };
      });
      this.state.operation = { kind: 'command', id: request.requestId, action: 'echo' };
      this.publish();
      void child.request({ type: 'prompt', message: `/option-market ${JSON.stringify(request)}` }).then(ack => {
        if (this.active?.id !== request.requestId) return;
        if (object(ack.data).disposition !== 'handled') throw new Error('Pi echo command was not handled.');
        this.active.ack = true;
        this.complete();
      }).catch(error => { if (this.active?.id === request.requestId) this.fail(error); });
      return promise;
    } catch (error) { return Promise.reject(error); }
  }

  private available(): PiProcess {
    if (this.active) throw new Error('Pi is busy.');
    if (this.state.connection.kind !== 'ready' || !this.child) throw new Error('Pi is not ready.');
    return this.child;
  }

  private advice(): Extract<Active, { kind: 'advice' }> {
    if (this.active?.kind !== 'advice' || this.active.settled) throw new Error('Unexpected Pi advice event.');
    return this.active;
  }

  private receive(record: RpcRecord): void {
    switch (record.type) {
      case 'rpc_error': case 'extension_error':
        throw new Error(boundedText(record.error, 1048576));
      case 'auto_retry_start': case 'compaction_start':
        throw new Error('Unexpected Pi retry or compaction.');
      case 'turn_start': {
        const active = this.advice();
        if (++active.turns > AGENT_LIMITS.maxTurns) throw new Error('Pi turn budget exceeded.');
        this.state.operation = { kind: 'advice', id: active.id, turns: active.turns, tools: active.tools };
        break;
      }
      case 'message_start': {
        this.advice();
        const message = object(record.message);
        if (message.role !== 'assistant') return;
        if (this.stream) throw new Error('Overlapping assistant messages.');
        const id = `assistant-${++this.sequence}`;
        this.stream = { id, blocks: new Map() };
        this.state.messages.push({ id, role: 'assistant', text: textContent(message.content), status: 'streaming' });
        break;
      }
      case 'message_update': {
        this.advice();
        const update = object(record.assistantMessageEvent);
        if (update.type === 'error') throw new Error('Pi provider stream failed.');
        if (update.type !== 'text_delta' && update.type !== 'text_end') return;
        if (!this.stream || !Number.isSafeInteger(update.contentIndex) || typeof update.contentIndex !== 'number' || update.contentIndex < 0) throw new Error('Invalid assistant text update.');
        const text = boundedText(update.type === 'text_delta' ? update.delta : update.content, 1048576);
        this.stream.blocks.set(update.contentIndex, update.type === 'text_delta' ? (this.stream.blocks.get(update.contentIndex) ?? '') + text : text);
        const message = this.state.messages.find(message => message.id === this.stream?.id);
        if (message) message.text = [...this.stream.blocks].sort(([a], [b]) => a - b).map(([, text]) => text).join('');
        break;
      }
      case 'message_end': {
        this.advice();
        const message = object(record.message);
        if (message.role !== 'assistant') return;
        if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error(typeof message.errorMessage === 'string' ? message.errorMessage : 'Pi assistant failed.');
        if (!this.stream) throw new Error('Assistant message ended without a start.');
        const transcript = this.state.messages.find(message => message.id === this.stream?.id);
        if (transcript) { transcript.text = textContent(message.content); transcript.status = 'complete'; }
        this.stream = null;
        break;
      }
      case 'tool_execution_start': {
        const active = this.advice();
        const id = boundedText(record.toolCallId, 256);
        const name = boundedText(record.toolName, 128);
        if (!id || this.state.tools.some(tool => tool.id === id)) throw new Error('Invalid or duplicate tool start.');
        if (name !== 'hello' && name !== 'read') throw new Error('Tool is not allowed.');
        if (++active.tools > AGENT_LIMITS.maxTools) throw new Error('Pi tool budget exceeded.');
        this.state.tools.push({ kind: 'running', id, name, input: record.args });
        this.state.operation = { kind: 'advice', id: active.id, turns: active.turns, tools: active.tools };
        break;
      }
      case 'tool_execution_end': {
        this.advice();
        const index = this.state.tools.findIndex(tool => tool.id === record.toolCallId);
        const tool = this.state.tools[index];
        if (!tool || tool.kind !== 'running' || tool.name !== record.toolName || typeof record.isError !== 'boolean') throw new Error('Unmatched or duplicate tool end.');
        const result = object(record.result);
        const text = textContent(result.content);
        if (record.isError || result.isError === true) {
          this.state.tools[index] = { ...tool, kind: 'failed', error: text };
          throw new Error(`Pi tool failed: ${text}`);
        }
        this.state.tools[index] = { ...tool, kind: 'succeeded', text, hello: tool.name === 'hello' ? parseHello(result.details) : null };
        break;
      }
      case 'agent_settled': {
        const active = this.advice();
        if (record.aborted !== false || !active.turns || this.stream || this.state.tools.some(tool => tool.kind === 'running')) throw new Error('Pi aborted or settled with unfinished work.');
        active.settled = true;
        this.complete();
        return;
      }
      case 'entry_appended': {
        const entry = object(record.entry);
        if (entry.customType !== 'option-market-result/v1') return;
        const result = parseMarketResult(entry.data);
        const active = this.active;
        if (active?.kind !== 'command' || result.requestId !== active.id) return;
        if (active.result) throw new Error('Duplicate echo result.');
        if (result.status === 'error') throw new Error(result.error);
        if (result.text !== active.text) throw new Error('Echo result differs from request.');
        active.result = result;
        this.complete();
        return;
      }
      default: return;
    }
    this.publish();
  }

  private complete(): void {
    const active = this.active;
    if (!active?.ack) return;
    if (active.kind === 'advice' && !active.settled || active.kind === 'command' && !active.result) return;
    clearTimeout(active.timer);
    this.active = null;
    this.state.operation = { kind: 'idle' };
    this.publish();
    if (active.kind === 'advice') active.resolve();
    else if (active.result) active.resolve(active.result);
  }

  private fail(error: unknown): void {
    const failure = error instanceof Error ? error : new Error('Pi failed.');
    this.finishFailed(failure);
    this.state.connection = { kind: 'failed', error: failure.message };
    this.state.operation = { kind: 'failed', error: failure.message };
    this.publish();
    void this.child?.stop();
  }

  private finishFailed(error: Error): void {
    if (this.active) { clearTimeout(this.active.timer); this.active.reject(error); this.active = null; }
    for (const message of this.state.messages) if (message.status === 'streaming') message.status = 'failed';
    this.state.tools = this.state.tools.map(tool => tool.kind === 'running' ? { ...tool, kind: 'failed', error: error.message } : tool);
    this.stream = null;
  }

  async stop(): Promise<void> {
    const generation = ++this.generation;
    const child = this.child;
    this.state.connection = { kind: 'closing' };
    this.finishFailed(new Error('Pi stopped.'));
    this.state.operation = { kind: 'idle' };
    this.publish();
    await child?.stop();
    if (generation !== this.generation || child !== this.child) return;
    this.state.connection = { kind: 'stopped' };
    this.publish();
  }

  restart(): Promise<void> {
    if (this.restarting) return this.restarting;
    const requestedGeneration = this.generation;
    return this.restarting = Promise.resolve().then(async () => {
      if (requestedGeneration !== this.generation) throw new Error('Pi restart was interrupted.');
      const stopping = this.stop();
      const generation = this.generation;
      await stopping;
      if (generation !== this.generation) throw new Error('Pi restart was interrupted.');
      this.child = null;
      this.state = { connection: { kind: 'new' }, operation: { kind: 'idle' }, messages: [], tools: [] };
      await this.start();
    }).finally(() => { this.restarting = null; });
  }
}
