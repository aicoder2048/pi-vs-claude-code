import {
  boundedText, object, type ContractQuery, type DailyBar, type DailyBarsQuery, type DataResult,
  type MarketPanel, type MarketQuery, type MarketRequest, type MarketResult, type MarketToolResult,
  type OptionChainQuery, type OptionSnapshot,
} from '../types.ts';
import { decodeDataResult, parseContractQuery, parseDailyBarsQuery, parseOptionChainQuery } from './normalize.ts';

export const MARKET_RESULT_ENTRY = 'option-market-result/v1';

function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  const data = object(value);
  const prototype: unknown = Object.getPrototypeOf(data);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('Invalid market object.');
  for (const key of Reflect.ownKeys(data)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw new Error('Unexpected market field.');
    const descriptor = Object.getOwnPropertyDescriptor(data, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('Invalid market field.');
  }
  return data;
}

export function parseDailyBarsInput(value: unknown): DailyBarsQuery {
  return parseDailyBarsQuery(fields(value, ['symbol', 'days']));
}

export function parseOptionChainInput(value: unknown): OptionChainQuery {
  const data = fields(value, ['symbol', 'expiry', 'side', 'strikeRange']);
  if (data.strikeRange !== undefined) fields(data.strikeRange, ['min', 'max']);
  return parseOptionChainQuery(data);
}

export function parseContractInput(value: unknown): ContractQuery {
  return parseContractQuery(fields(value, ['occ']));
}

export function parseMarketQuery(value: unknown): MarketQuery {
  const data = fields(value, ['symbol', 'days', 'expiry', 'side', 'strikeRange']);
  return { ...parseOptionChainInput({ symbol: data.symbol, expiry: data.expiry,
    ...(Object.hasOwn(data, 'side') ? { side: data.side } : {}), strikeRange: data.strikeRange }),
    ...parseDailyBarsInput({ symbol: data.symbol, days: data.days }) };
}

function requestId(value: unknown): string {
  const id = boundedText(value, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid command correlation.');
  return id;
}

export function parseMarketRequest(value: unknown): MarketRequest {
  const data = object(value);
  const id = requestId(data.requestId);
  switch (data.action) {
    case 'echo':
      fields(data, ['requestId', 'action', 'text']);
      return { requestId: id, action: 'echo', text: boundedText(data.text) };
    case 'market':
      fields(data, ['requestId', 'action', 'query']);
      return { requestId: id, action: 'market', query: parseMarketQuery(data.query) };
    case 'contract':
      fields(data, ['requestId', 'action', 'occ']);
      return { requestId: id, action: 'contract', ...parseContractInput({ occ: data.occ }) };
    default: throw new Error('Invalid market request action.');
  }
}

export function sameQuery(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonical<T>(raw: unknown, query: T): T {
  const data = object(raw);
  if (Object.keys(data).length !== Object.keys(object(query)).length
    || Object.entries(object(query)).some(([key, value]) => !sameQuery(value, data[key]))) {
    throw new Error('Noncanonical market query.');
  }
  return query;
}

function checkAsOf(result: DataResult<DailyBar | OptionSnapshot>): void {
  const times = result.rows.map(row => 'startedAt' in row ? row.startedAt : row.quotedAt)
    .filter(time => time !== null).sort();
  if (result.asOf !== (times.at(-1) ?? null)) throw new Error('Market asOf does not match rows.');
}

function dailyResult(query: DailyBarsQuery, value: unknown): DataResult<DailyBar> {
  const result = decodeDataResult('dailyBars', value);
  if (result.rows.length > query.days || result.status === 'ok' && result.rows.length !== query.days) {
    throw new Error('Market daily count differs from query.');
  }
  let previous = '';
  for (const row of result.rows) {
    if (row.symbol !== query.symbol || row.date <= previous) throw new Error('Market bars differ from query.');
    previous = row.date;
  }
  checkAsOf(result);
  return result;
}

function chainResult(query: OptionChainQuery, value: unknown): DataResult<OptionSnapshot> {
  const result = decodeDataResult('optionChain', value);
  if (result.rows.some(row => row.symbol !== query.symbol || query.expiry !== undefined && row.expiry !== query.expiry
    || query.side !== undefined && row.side !== query.side
    || query.strikeRange !== undefined && (row.strike < query.strikeRange.min || row.strike > query.strikeRange.max))) {
    throw new Error('Market chain differs from query.');
  }
  checkAsOf(result);
  return result;
}

function contractResult(query: ContractQuery, value: unknown): DataResult<OptionSnapshot> {
  const result = decodeDataResult('contract', value);
  if (result.rows.some(row => row.occ !== query.occ)) throw new Error('Market contract differs from query.');
  checkAsOf(result);
  return result;
}

function panel(value: unknown): MarketPanel {
  const data = fields(value, ['symbol', 'query', 'bars', 'chain']);
  const query = canonical(data.query, parseMarketQuery(data.query));
  if (data.symbol !== query.symbol) throw new Error('Market panel symbol differs from query.');
  return { symbol: query.symbol, query, bars: dailyResult(query, data.bars), chain: chainResult(query, data.chain) };
}

function boundedResult<T>(result: T): T {
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength >= 900_000) throw new Error('Oversized market result.');
  return result;
}

export function parseMarketResult(value: unknown): MarketResult {
  const data = object(value);
  const id = requestId(data.requestId);
  if (data.status === 'error') {
    fields(data, ['requestId', 'status', 'error']);
    return { requestId: id, status: 'error', error: boundedText(data.error) };
  }
  if (data.status !== 'ok') throw new Error('Invalid market result status.');
  switch (data.action) {
    case 'echo':
      fields(data, ['requestId', 'status', 'action', 'text', 'marker', 'stage']);
      if (data.marker !== 'option-agent' || data.stage !== 0) throw new Error('Invalid Stage 0 echo result.');
      return { requestId: id, status: 'ok', action: 'echo', text: boundedText(data.text), marker: 'option-agent', stage: 0 };
    case 'market':
      fields(data, ['requestId', 'status', 'action', 'panel']);
      return boundedResult({ requestId: id, status: 'ok', action: 'market', panel: panel(data.panel) });
    case 'contract': {
      fields(data, ['requestId', 'status', 'action', 'occ', 'result']);
      const query = parseContractInput({ occ: data.occ });
      if (query.occ !== data.occ) throw new Error('Noncanonical market OCC.');
      return boundedResult({ requestId: id, status: 'ok', action: 'contract', occ: query.occ, result: contractResult(query, data.result) });
    }
    default: throw new Error('Invalid market result action.');
  }
}

export function parseMarketToolResult(value: unknown): MarketToolResult {
  const data = fields(value, ['kind', 'query', 'result']);
  switch (data.kind) {
    case 'dailyBars': {
      const query = canonical(data.query, parseDailyBarsInput(data.query));
      return boundedResult({ kind: 'dailyBars', query, result: dailyResult(query, data.result) });
    }
    case 'optionChain': {
      const query = canonical(data.query, parseOptionChainInput(data.query));
      return boundedResult({ kind: 'optionChain', query, result: chainResult(query, data.result) });
    }
    case 'contract': {
      const query = canonical(data.query, parseContractInput(data.query));
      return boundedResult({ kind: 'contract', query, result: contractResult(query, data.result) });
    }
    default: throw new Error('Invalid market tool result kind.');
  }
}
