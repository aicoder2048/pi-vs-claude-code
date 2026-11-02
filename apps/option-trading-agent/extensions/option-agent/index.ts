import { realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type, type TSchema } from '@sinclair/typebox';
import { assertModel, OPTION_AGENT_TOOL_NAMES as names, OPTION_AGENT_TOOLS } from '../../src/agent/config.ts';
import { AGENT_LIMITS, boundedText, object, type Hello, type MarketResult, type MarketToolResult } from '../../src/business/types.ts';
import { MarketData } from '../../src/business/market-data/client.ts';
import {
  MARKET_RESULT_ENTRY, parseContractInput, parseDailyBarsInput, parseMarketRequest,
  parseMarketResult, parseOptionChainInput,
} from '../../src/business/market-data/protocol.ts';

export interface ExtensionContext {
  cwd: string;
  model: { provider: string; id: string } | undefined;
  abort(): void;
  shutdown(): void;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  details: Hello | MarketToolResult;
  isError?: false;
}

export interface OptionExtensionAPI {
  registerTool(tool: {
    name: string; label: string; description: string; parameters: TSchema;
    executionMode?: 'sequential';
    annotations?: { readOnlyHint: true; destructiveHint: false; idempotentHint: true; openWorldHint: true };
    execute(id: string, input: unknown, signal: AbortSignal | undefined, update: unknown, ctx: ExtensionContext): Promise<ToolResult>;
  }): void;
  registerCommand(name: string, command: { description: string; handler(args: string, ctx: ExtensionContext): Promise<void> }): void;
  on(event: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown): unknown;
  appendEntry(customType: string, data: unknown): void;
}

const skills = resolve(dirname(fileURLToPath(import.meta.url)), '../../skills');

async function authorizedReadPath(input: unknown, cwd: string): Promise<string | undefined> {
  try {
    const path = boundedText(object(input).path, 4096);
    if (!path) return undefined;
    const target = resolve(cwd, path);
    const canonicalSkills = await realpath(skills);
    const canonicalTarget = await realpath(target);
    if (canonicalSkills !== skills || canonicalTarget !== target) return undefined;
    const rel = relative(canonicalSkills, canonicalTarget);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) return undefined;
    return canonicalTarget;
  } catch { return undefined; }
}

function toolResult(details: MarketToolResult): ToolResult {
  const { result } = details;
  const rows = details.kind === 'optionChain' ? result.rows.slice(0, 10) : result.rows;
  const omittedRows = result.rows.length - rows.length;
  const text = JSON.stringify({ kind: details.kind, query: details.query, status: result.status,
    provider: result.provider, source: result.source, asOf: result.asOf, fetchedAt: result.fetchedAt,
    issues: result.issues.slice(0, 8), totalIssues: result.issues.length,
    totalRows: result.rows.length, shownRows: rows.length, omittedRows,
    ...(omittedRows > 0 ? { guidance: 'Option chain is truncated. Narrow side, expiry, or strikeRange and call get_option_chain again; do not treat these rows as exhaustive.' } : {}),
    rows });
  return { content: [{ type: 'text', text }], details, isError: false };
}

export default function optionAgent(pi: OptionExtensionAPI, dependencies?: { marketData: MarketData }): void {
  let marketData = dependencies?.marketData;
  const service = (): MarketData => marketData ??= new MarketData();
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
    name: names.hello, label: 'Hello', description: 'Check advice-only tool transport. Does not retrieve market data or place orders.',
    parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }) }, { additionalProperties: false }),
    async execute(_id, input) {
      const name = boundedText(object(input).name, 120);
      if (!name.trim()) throw new Error('Hello requires a name.');
      const details: Hello = { kind: 'hello', name, greeting: `Hello, ${name}!`, adviceOnly: true };
      return { content: [{ type: 'text', text: details.greeting }], details };
    },
  });
  const symbol = Type.String({ minLength: 1, maxLength: 16 });
  const expiry = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
  const strikeRange = Type.Object({ min: Type.Number({ minimum: 0 }), max: Type.Number({ minimum: 0 }) }, { additionalProperties: false });
  const marketTool = { executionMode: 'sequential', annotations: {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  } } as const;
  pi.registerTool({
    ...marketTool, name: names.dailyBars, label: 'Daily bars', description: 'Get up to 500 daily bars. Report status, provenance and missing history. Does not place orders.',
    parameters: Type.Object({ symbol, days: Type.Integer({ minimum: 1, maximum: 500 }) }, { additionalProperties: false }),
    async execute(_id, input, signal) {
      const query = parseDailyBarsInput(input);
      return toolResult({ kind: 'dailyBars', query, result: await service().dailyBars(query, signal) });
    },
  });
  pi.registerTool({
    ...marketTool, name: names.optionChain, label: 'Option chain', description: 'Get a bounded option snapshot chain, optionally filtered by side (put or call), expiry, and strike range. Model text shows at most ten rows, not an exhaustive chain. Missing quotes are null. Does not place orders.',
    parameters: Type.Object({ symbol, expiry: Type.Optional(expiry),
      side: Type.Optional(Type.Union([Type.Literal('put'), Type.Literal('call')])),
      strikeRange: Type.Optional(strikeRange) }, { additionalProperties: false }),
    async execute(_id, input, signal) {
      const query = parseOptionChainInput(input);
      return toolResult({ kind: 'optionChain', query, result: await service().optionChain(query, signal) });
    },
  });
  pi.registerTool({
    ...marketTool, name: names.contract, label: 'Option contract', description: 'Get one OCC option contract snapshot with explicit status and missing fields. Does not place orders.',
    parameters: Type.Object({ occ: Type.String({ minLength: 16, maxLength: 33 }) }, { additionalProperties: false }),
    async execute(_id, input, signal) {
      const query = parseContractInput(input);
      return toolResult({ kind: 'contract', query, result: await service().contract(query, signal) });
    },
  });
  pi.registerCommand('option-agent', {
    description: 'Option agent Stage 0 resource marker.',
    async handler() { pi.appendEntry('option-agent/v1', { marker: 'option-agent', stage: 0 }); },
  });
  pi.registerCommand('option-market', {
    description: 'Read market data or echo through correlated entries, without starting a model turn.',
    async handler(args) {
      let requestId = 'invalid-request';
      let result: MarketResult;
      try {
        const raw = object(JSON.parse(args));
        if (typeof raw.requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(raw.requestId)) requestId = raw.requestId;
        const request = parseMarketRequest(raw);
        switch (request.action) {
          case 'echo':
            result = { requestId, action: 'echo', status: 'ok', text: request.text, marker: 'option-agent', stage: 0 };
            break;
          case 'market': {
            const bars = await service().dailyBars(request.query);
            const chain = await service().optionChain(request.query);
            result = { requestId, action: 'market', status: 'ok', panel: {
              symbol: request.query.symbol, query: request.query, bars, chain,
            } };
            break;
          }
          case 'contract':
            result = { requestId, action: 'contract', status: 'ok', occ: request.occ,
              result: await service().contract({ occ: request.occ }) };
            break;
        }
        result = parseMarketResult(result);
      } catch { result = { requestId, status: 'error', error: 'Invalid market request or result.' }; }
      pi.appendEntry(MARKET_RESULT_ENTRY, result);
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
    if (typeof event.toolName !== 'string' || !OPTION_AGENT_TOOLS.includes(event.toolName)) return { block: true, reason: 'Tool is not allowed.' };
    if (event.toolName === names.read) {
      const path = await authorizedReadPath(event.input, ctx.cwd);
      if (path === undefined) return { block: true, reason: 'Read is restricted to real files under option-agent skills, without escaping paths or symlink aliases.' };
      object(event.input).path = path;
    }
    return undefined;
  });
}
