export interface MarketDataMetadata {
  fetchedAt: string;
  source: 'network' | 'cache';
  asOf?: string | null;
}

export type DataResult<T> = {
  provider: 'massive';
  asOf: string | null;
  fetchedAt: string;
  source: 'network' | 'cache';
  issues: string[];
} & (
  | { status: 'ok' | 'partial'; rows: T[] }
  | { status: 'empty' | 'unavailable' | 'error'; rows: [] }
);

export interface DailyBar {
  symbol: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  startedAt: string;
  provisional: boolean;
}

export interface OptionSnapshot {
  occ: string;
  symbol: string;
  expiry: string;
  side: 'put' | 'call';
  strike: number;
  bid: number | null;
  ask: number | null;
  iv: number | null;
  greeks: { delta: number | null; gamma: number | null; theta: number | null; vega: number | null };
  openInterest: number | null;
  volume: number | null;
  quotedAt: string | null;
}

export interface MarketHoliday {
  date: string;
  exchange: string;
  status: 'closed' | 'early-close';
  open: string | null;
  close: string | null;
}

export interface TreasuryRate {
  date: string;
  annualRate: number;
}

export interface DailyBarsQuery { symbol: string; days: number }
export interface OptionChainQuery {
  symbol: string;
  expiry?: string;
  side?: 'put' | 'call';
  strikeRange?: { min: number; max: number };
}
export interface ContractQuery { occ: string }
export type OccContract = Pick<OptionSnapshot, 'occ' | 'symbol' | 'expiry' | 'side' | 'strike'>;

export const AGENT_LIMITS = Object.freeze({ maxTurns: 12, maxTools: 24 });
export const REQUIRED_SKILLS = Object.freeze([
  'option-coach', 'principle-facts-over-heuristics', 'principle-advice-not-orders',
]);

export interface Hello {
  kind: 'hello';
  name: string;
  greeting: string;
  adviceOnly: true;
}

export type MarketQuery = DailyBarsQuery & OptionChainQuery;

export interface MarketPanel {
  symbol: string;
  query: MarketQuery;
  bars: DataResult<DailyBar>;
  chain: DataResult<OptionSnapshot>;
}

export type MarketCommand =
  | { action: 'echo'; text: string }
  | { action: 'market'; query: MarketQuery }
  | { action: 'contract'; occ: string };
export type MarketRequest = MarketCommand & { requestId: string };

export type MarketResult =
  | { requestId: string; status: 'ok'; action: 'echo'; text: string; marker: 'option-agent'; stage: 0 }
  | { requestId: string; status: 'ok'; action: 'market'; panel: MarketPanel }
  | { requestId: string; status: 'ok'; action: 'contract'; occ: string; result: DataResult<OptionSnapshot> }
  | { requestId: string; status: 'error'; error: string };

export type MarketToolResult =
  | { kind: 'dailyBars'; query: DailyBarsQuery; result: DataResult<DailyBar> }
  | { kind: 'optionChain'; query: OptionChainQuery; result: DataResult<OptionSnapshot> }
  | { kind: 'contract'; query: ContractQuery; result: DataResult<OptionSnapshot> };

export type AgentConnection =
  | { kind: 'new' }
  | { kind: 'starting' }
  | { kind: 'ready'; model: string }
  | { kind: 'closing' }
  | { kind: 'stopped' }
  | { kind: 'failed'; error: string };

export type AgentOperation =
  | { kind: 'idle' }
  | { kind: 'advice'; id: string; turns: number; tools: number }
  | { kind: 'command'; id: string; action: MarketRequest['action'] }
  | { kind: 'failed'; error: string };

export interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status: 'streaming' | 'complete' | 'failed';
}

export type ToolLog = { id: string; name: string; input: unknown } & (
  | { kind: 'running' }
  | { kind: 'succeeded'; text: string; hello: Hello | null; market: MarketToolResult | null }
  | { kind: 'failed'; error: string }
);

export interface AgentView {
  connection: AgentConnection;
  operation: AgentOperation;
  messages: TranscriptMessage[];
  tools: ToolLog[];
  market: MarketPanel | null;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}

export function boundedText(value: unknown, max = 16000): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('Invalid text.');
  return value;
}

export function parseHello(value: unknown): Hello {
  const data = object(value);
  if (data.kind !== 'hello' || data.adviceOnly !== true) throw new Error('Invalid hello result.');
  const name = boundedText(data.name, 120);
  const greeting = boundedText(data.greeting, 160);
  if (greeting !== `Hello, ${name}!`) throw new Error('Invalid hello greeting.');
  return { kind: 'hello', name, greeting, adviceOnly: true };
}
