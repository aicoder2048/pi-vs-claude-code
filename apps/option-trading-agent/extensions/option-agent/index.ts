import { realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type, type TSchema } from '@sinclair/typebox';
import { assertModel } from '../../src/agent/config.ts';
import { AGENT_LIMITS, boundedText, object, parseMarketRequest, type Hello, type MarketResult } from '../../src/business/types.ts';

export interface ExtensionContext {
  cwd: string;
  model: { provider: string; id: string } | undefined;
  abort(): void;
  shutdown(): void;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  details: Hello;
}

export interface OptionExtensionAPI {
  registerTool(tool: {
    name: string; label: string; description: string; parameters: TSchema;
    execute(id: string, input: unknown, signal: AbortSignal | undefined, update: unknown, ctx: ExtensionContext): Promise<ToolResult>;
  }): void;
  registerCommand(name: string, command: { description: string; handler(args: string, ctx: ExtensionContext): Promise<void> }): void;
  on(event: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown): unknown;
  appendEntry(customType: string, data: unknown): void;
}

const skills = resolve(dirname(fileURLToPath(import.meta.url)), '../../skills');

async function allowRead(input: unknown, cwd: string): Promise<boolean> {
  try {
    const path = boundedText(object(input).path, 4096);
    if (!path || path.split(/[\\/]/).includes('..')) return false;
    const target = resolve(cwd, path);
    const rel = relative(skills, target);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) return false;
    return await realpath(skills) === skills && await realpath(target) === target;
  } catch { return false; }
}

export default function optionAgent(pi: OptionExtensionAPI): void {
  let turns = 0;
  let tools = 0;
  const requestedModel = process.env.OPTION_AGENT_EXPECTED_MODEL ?? process.env.OPTION_AGENT_MODEL ?? 'openai-codex/gpt-6.1-sol';
  const guardModel = (ctx: ExtensionContext): void => {
    assertModel(requestedModel);
    const actual = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : '';
    assertModel(actual);
    if (actual !== requestedModel) throw new Error('Resolved Pi model does not match the requested model.');
  };

  pi.registerTool({
    name: 'hello', label: 'Hello', description: 'Check advice-only tool transport. Does not retrieve market data or place orders.',
    parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }) }, { additionalProperties: false }),
    async execute(_id, input) {
      const name = boundedText(object(input).name, 120);
      if (!name.trim()) throw new Error('Hello requires a name.');
      const details: Hello = { kind: 'hello', name, greeting: `Hello, ${name}!`, adviceOnly: true };
      return { content: [{ type: 'text', text: details.greeting }], details };
    },
  });
  pi.registerCommand('option-agent', {
    description: 'Option agent Stage 0 resource marker.',
    async handler() { pi.appendEntry('option-agent/v1', { marker: 'option-agent', stage: 0 }); },
  });
  pi.registerCommand('option-market', {
    description: 'Stage 0 correlated echo only. No model or market data.',
    async handler(args) {
      let requestId = 'invalid-request';
      let result: MarketResult;
      try {
        const raw = object(JSON.parse(args));
        if (typeof raw.requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(raw.requestId)) requestId = raw.requestId;
        const request = parseMarketRequest(raw);
        result = { requestId: request.requestId, action: 'echo', status: 'ok', text: request.text, marker: 'option-agent', stage: 0 };
      } catch { result = { requestId, status: 'error', error: 'Invalid Stage 0 echo request.' }; }
      pi.appendEntry('option-market-result/v1', result);
    },
  });
  pi.on('input', () => { turns = 0; tools = 0; return { action: 'continue' }; });
  pi.on('cache_warming_decision', () => ({ action: 'stop' }));
  pi.on('turn_start', (_event, ctx) => {
    try {
      guardModel(ctx);
      if (++turns > AGENT_LIMITS.maxTurns) throw new Error('Pi turn budget exceeded.');
    } catch (error) {
      ctx.abort();
      ctx.shutdown();
      throw error;
    }
  });
  pi.on('tool_call', async (event, ctx) => {
    if (++tools > AGENT_LIMITS.maxTools) return { block: true, reason: 'Pi tool budget exceeded.' };
    if (event.toolName !== 'read' && event.toolName !== 'hello') return { block: true, reason: 'Tool is not allowed.' };
    if (event.toolName === 'read' && !await allowRead(event.input, ctx.cwd)) return { block: true, reason: 'Read is restricted to real files under option-agent skills, without traversal or symlinks.' };
    return undefined;
  });
}
