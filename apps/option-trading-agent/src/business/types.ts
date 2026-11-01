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

export interface MarketRequest {
  requestId: string;
  action: 'echo';
  text: string;
}

export type MarketResult =
  | { requestId: string; status: 'ok'; action: 'echo'; text: string; marker: 'option-agent'; stage: 0 }
  | { requestId: string; status: 'error'; error: string };

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
  | { kind: 'command'; id: string; action: 'echo' }
  | { kind: 'failed'; error: string };

export interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status: 'streaming' | 'complete' | 'failed';
}

export type ToolLog = { id: string; name: string; input: unknown } & (
  | { kind: 'running' }
  | { kind: 'succeeded'; text: string; hello: Hello | null }
  | { kind: 'failed'; error: string }
);

export interface AgentView {
  connection: AgentConnection;
  operation: AgentOperation;
  messages: TranscriptMessage[];
  tools: ToolLog[];
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}

export function boundedText(value: unknown, max = 16000): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('Invalid text.');
  return value;
}

export function parseMarketRequest(value: unknown): MarketRequest {
  const data = object(value);
  const requestId = boundedText(data.requestId, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(requestId) || data.action !== 'echo') throw new Error('Invalid Stage 0 echo request.');
  return { requestId, action: 'echo', text: boundedText(data.text) };
}

export function parseMarketResult(value: unknown): MarketResult {
  const data = object(value);
  const requestId = boundedText(data.requestId, 128);
  if (!requestId) throw new Error('Missing command correlation.');
  if (data.status === 'error') return { requestId, status: 'error', error: boundedText(data.error) };
  if (data.status !== 'ok' || data.action !== 'echo' || data.marker !== 'option-agent' || data.stage !== 0) throw new Error('Invalid Stage 0 echo result.');
  return { requestId, status: 'ok', action: 'echo', text: boundedText(data.text), marker: 'option-agent', stage: 0 };
}

export function parseHello(value: unknown): Hello {
  const data = object(value);
  if (data.kind !== 'hello' || data.adviceOnly !== true) throw new Error('Invalid hello result.');
  const name = boundedText(data.name, 120);
  const greeting = boundedText(data.greeting, 160);
  if (greeting !== `Hello, ${name}!`) throw new Error('Invalid hello greeting.');
  return { kind: 'hello', name, greeting, adviceOnly: true };
}
