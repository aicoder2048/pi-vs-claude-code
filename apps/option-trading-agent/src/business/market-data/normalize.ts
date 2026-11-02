import type {
  ContractQuery, DailyBar, DailyBarsQuery, DataResult, MarketDataMetadata, MarketHoliday,
  OccContract, OptionChainQuery, OptionSnapshot, TreasuryRate,
} from '../types.ts';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function requiredRecord(value: unknown): Record<string, unknown> {
  const row = record(value);
  if (!row) throw new Error('Expected an object.');
  return row;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonnegative(value: unknown): number | null {
  const n = number(value);
  return n !== null && n >= 0 ? n : null;
}

export function parseSymbol(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,15}$/.test(value)) {
    throw new Error('Invalid market symbol.');
  }
  return value.toUpperCase();
}

export function parseDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid calendar date.');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error('Invalid calendar date.');
  }
  return value;
}

export function parseOcc(value: unknown): OccContract {
  if (typeof value !== 'string') throw new Error('Invalid OCC contract.');
  const match = /^(?:O:)?([A-Za-z0-9][A-Za-z0-9.-]{0,15})(\d{6})([PC])(\d{8})$/.exec(value);
  if (!match || match[0] !== value) throw new Error('Invalid OCC contract.');
  const symbol = parseSymbol(match[1]);
  const date = match[2];
  const expiry = parseDate(`20${date.slice(0, 2)}-${date.slice(2, 4)}-${date.slice(4, 6)}`);
  const strike = Number(match[4]) / 1000;
  if (strike <= 0) throw new Error('Invalid OCC strike.');
  return { occ: `O:${symbol}${date}${match[3]}${match[4]}`, symbol, expiry,
    side: match[3] === 'P' ? 'put' : 'call', strike };
}

export function parseDailyBarsQuery(value: unknown): DailyBarsQuery {
  const data = requiredRecord(value);
  if (typeof data.days !== 'number' || !Number.isInteger(data.days) || data.days < 1 || data.days > 500) {
    throw new Error('Days must be an integer between 1 and 500.');
  }
  return { symbol: parseSymbol(data.symbol), days: data.days };
}

export function parseOptionChainQuery(value: unknown): OptionChainQuery {
  const data = requiredRecord(value);
  const query: OptionChainQuery = { symbol: parseSymbol(data.symbol) };
  if (data.expiry !== undefined) query.expiry = parseDate(data.expiry);
  if (Object.hasOwn(data, 'side')) {
    if (data.side !== 'put' && data.side !== 'call') throw new Error('Invalid option side.');
    query.side = data.side;
  }
  if (data.strikeRange !== undefined) {
    const range = requiredRecord(data.strikeRange);
    const min = nonnegative(range.min);
    const max = nonnegative(range.max);
    if (min === null || max === null || min > max) throw new Error('Invalid strike range.');
    query.strikeRange = { min, max };
  }
  return query;
}

export function parseContractQuery(value: unknown): ContractQuery {
  return { occ: parseOcc(requiredRecord(value).occ).occ };
}

export function millisecondsToIso(value: unknown): string | null {
  const n = typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value)
    : typeof value === 'string' && value.trim() === value && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 8_640_000_000_000_000) return null;
  return new Date(Math.floor(n)).toISOString();
}

export function nanosecondsToIso(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? millisecondsToIso(BigInt(value) / 1_000_000n) : null;
  }
  if (typeof value !== 'bigint' && !(typeof value === 'string' && value.trim() === value && /^\d{1,25}$/.test(value))) return null;
  const n = BigInt(value);
  return n >= 0n ? millisecondsToIso(n / 1_000_000n) : null;
}

function optionQuoteTime(quotedAt: string | null, fetchedAt: string): string | null {
  return quotedAt !== null && Date.parse(quotedAt) <= Date.parse(fetchedAt) + 5 * 60_000 ? quotedAt : null;
}

const newYork = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

function sessionDate(iso: string): string {
  return newYork.format(new Date(iso));
}

function newest(values: (string | null)[]): string | null {
  return values.reduce<string | null>((latest, value) => value !== null && (latest === null || value > latest) ? value : latest, null);
}

function failure<T>(metadata: MarketDataMetadata, status: 'error' | 'unavailable', issue: string): DataResult<T> {
  return { provider: 'massive', fetchedAt: metadata.fetchedAt, source: metadata.source,
    asOf: null, status, rows: [], issues: [issue] };
}

function finish<T>(rows: T[], metadata: MarketDataMetadata, issues: string[], asOf: string | null): DataResult<T> {
  const base = { provider: 'massive' as const, fetchedAt: metadata.fetchedAt, source: metadata.source,
    asOf: metadata.asOf !== undefined ? metadata.asOf : asOf, issues: [...new Set(issues)] };
  if (issues.length) return { ...base, status: 'partial', rows };
  if (!rows.length) return { ...base, status: 'empty', rows: [] };
  return { ...base, status: 'ok', rows };
}

type Envelope = { kind: 'data'; results: unknown; issues: string[] }
  | { kind: 'failure'; status: 'error' | 'unavailable'; issue: string };

function envelope(raw: unknown, array = false): Envelope {
  const data = record(raw);
  if (data) {
    if (data.status !== undefined && typeof data.status !== 'string') {
      return { kind: 'failure', status: 'error', issue: 'Malformed provider status.' };
    }
    const status = data.status?.toUpperCase();
    if (status !== undefined && ['NOT_AUTHORIZED', 'NOT_ENTITLED', 'UNAVAILABLE', 'DENIED'].includes(status)) {
      return { kind: 'failure', status: 'unavailable', issue: 'Provider data is unavailable.' };
    }
    if (status === 'ERROR' || data.error) {
      return { kind: 'failure', status: 'error', issue: 'Provider reported an error.' };
    }
    if (status !== undefined && !['OK', 'DELAYED', 'PARTIAL', 'EMPTY'].includes(status)) {
      return { kind: 'failure', status: 'error', issue: 'Unrecognized provider status.' };
    }
    if (!array && 'results' in data) {
      const issues: string[] = [];
      if (status === 'PARTIAL') issues.push('Provider response is incomplete.');
      if (data.next_url) issues.push('Additional provider pages remain.');
      return { kind: 'data', results: data.results, issues };
    }
  }
  if (array && Array.isArray(raw)) return { kind: 'data', results: raw, issues: [] };
  return { kind: 'failure', status: 'error', issue: 'Malformed provider payload.' };
}

type ParsedRow<T> = { row: T; issues: string[] };

function collect<T>(raw: unknown, metadata: MarketDataMetadata, parse: (value: unknown) => ParsedRow<T>,
  select: (rows: T[], issues: string[]) => T[], time: (rows: T[]) => string | null, array = false): DataResult<T> {
  const body = envelope(raw, array);
  if (body.kind === 'failure') return failure(metadata, body.status, body.issue);
  if (!Array.isArray(body.results)) return failure(metadata, 'error', 'Expected a provider results array.');
  const issues = [...body.issues];
  const rows: T[] = [];
  for (const value of body.results) {
    try {
      const parsed = parse(value);
      rows.push(parsed.row);
      issues.push(...parsed.issues);
    } catch {
      issues.push('Invalid provider row omitted.');
    }
  }
  if (body.results.length && !rows.length) return failure(metadata, 'error', 'No valid provider rows.');
  const selected = select(rows, issues);
  return finish(selected, metadata, issues, time(selected));
}

export function normalizeDailyBars(raw: unknown, query: DailyBarsQuery, metadata: MarketDataMetadata): DataResult<DailyBar> {
  const data = record(raw);
  if (data?.ticker !== undefined && data.ticker !== query.symbol) return failure(metadata, 'error', 'Provider symbol does not match query.');
  const today = sessionDate(metadata.fetchedAt);
  return collect(raw, metadata, value => {
    const bar = requiredRecord(value);
    const startedAt = millisecondsToIso(bar.t);
    const open = nonnegative(bar.o), high = nonnegative(bar.h), low = nonnegative(bar.l), close = nonnegative(bar.c);
    if (!startedAt || open === null || high === null || low === null || close === null
      || open <= 0 || low <= 0 || close <= 0 || low > high || open < low || open > high || close < low || close > high) {
      throw new Error('Invalid OHLC bar.');
    }
    const volume = nonnegative(bar.v);
    const date = sessionDate(startedAt);
    return { row: { symbol: query.symbol, date, open, high, low, close, volume, startedAt,
      provisional: date === today }, issues: volume === null ? ['Bar volume is missing or invalid.'] : [] };
  }, (rows, issues) => {
    rows.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const dates = new Set<string>();
    const unique = rows.filter(row => {
      if (dates.has(row.date)) { issues.push('Duplicate daily session omitted.'); return false; }
      dates.add(row.date);
      return true;
    });
    if (unique.length > 0 && unique.length < query.days) issues.push('Insufficient daily history.');
    return unique.slice(-query.days);
  }, rows => newest(rows.map(row => row.startedAt)));
}

function optionRow(value: unknown, symbol: string, metadata: MarketDataMetadata): ParsedRow<OptionSnapshot> {
  const raw = requiredRecord(value);
  const details = requiredRecord(raw.details);
  const identity = parseOcc(details.ticker);
  const underlying = record(raw.underlying_asset);
  if (identity.symbol !== symbol || details.expiration_date !== identity.expiry
    || details.contract_type !== identity.side || details.strike_price !== identity.strike
    || (underlying?.ticker !== undefined && underlying.ticker !== identity.symbol)) {
    throw new Error('Inconsistent option identity.');
  }
  const quote = record(raw.last_quote);
  let bid = nonnegative(quote?.bid), ask = nonnegative(quote?.ask);
  const issues: string[] = [];
  if (bid !== null && ask !== null && bid > ask) {
    bid = null; ask = null;
    issues.push('Crossed option quote omitted.');
  }
  const rawIv = number(raw.implied_volatility);
  const iv = rawIv !== null && rawIv > 0 ? rawIv : null;
  const rawGreeks = record(raw.greeks);
  const delta = number(rawGreeks?.delta);
  const greeks = { delta: delta !== null && delta >= -1 && delta <= 1 ? delta : null,
    gamma: nonnegative(rawGreeks?.gamma), theta: number(rawGreeks?.theta), vega: nonnegative(rawGreeks?.vega) };
  const openInterest = nonnegative(raw.open_interest);
  const volume = nonnegative(record(raw.day)?.volume);
  const quotedAt = optionQuoteTime(nanosecondsToIso(quote?.last_updated), metadata.fetchedAt);
  if ([bid, ask, iv, openInterest, ...Object.values(greeks)].some(value => value === null)) {
    issues.push('Desired option quote fields are missing or invalid.');
  }
  if (volume === null) issues.push('Option volume is missing or invalid.');
  if (quotedAt === null) issues.push('Option quote time is missing or invalid.');
  return { row: { ...identity, bid, ask, iv, greeks, openInterest, volume, quotedAt }, issues };
}

export function normalizeOptionChain(raw: unknown, query: OptionChainQuery, metadata: MarketDataMetadata): DataResult<OptionSnapshot> {
  return collect(raw, metadata, value => optionRow(value, query.symbol, metadata), rows => rows.filter(row =>
    (query.expiry === undefined || row.expiry === query.expiry)
    && (query.side === undefined || row.side === query.side)
    && (query.strikeRange === undefined || (row.strike >= query.strikeRange.min && row.strike <= query.strikeRange.max))),
  rows => newest(rows.map(row => row.quotedAt)));
}

export function normalizeContract(raw: unknown, query: ContractQuery, metadata: MarketDataMetadata): DataResult<OptionSnapshot> {
  const body = envelope(raw);
  if (body.kind === 'failure') return failure(metadata, body.status, body.issue);
  if (body.results === null) return finish([], metadata, body.issues, null);
  let parsed: ParsedRow<OptionSnapshot>;
  try {
    const identity = parseOcc(query.occ);
    parsed = optionRow(body.results, identity.symbol, metadata);
    if (parsed.row.occ !== identity.occ) throw new Error('Contract mismatch.');
  } catch {
    return failure(metadata, 'error', 'Invalid provider contract identity.');
  }
  return finish([parsed.row], metadata, [...body.issues, ...parsed.issues], parsed.row.quotedAt);
}

function providerIso(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  try { parseDate(value.slice(0, 10)); } catch { return null; }
  const n = Date.parse(value);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}

export function normalizeMarketHolidays(raw: unknown, metadata: MarketDataMetadata): DataResult<MarketHoliday> {
  return collect(raw, metadata, value => {
    const raw = requiredRecord(value);
    const date = parseDate(raw.date);
    if (typeof raw.exchange !== 'string' || !/^[A-Za-z][A-Za-z0-9 .-]{0,39}$/.test(raw.exchange)
      || (raw.status !== 'closed' && raw.status !== 'early-close')) throw new Error('Invalid market holiday.');
    const open = raw.open === null || raw.open === undefined ? null : providerIso(raw.open);
    const close = raw.close === null || raw.close === undefined ? null : providerIso(raw.close);
    const issues: string[] = [];
    if ((raw.open != null && open === null) || (raw.close != null && close === null)
      || (raw.status === 'early-close' && (!open || !close))) issues.push('Holiday session times are missing or invalid.');
    if ((open && sessionDate(open) !== date) || (close && sessionDate(close) !== date)
      || (open && close && open >= close)) {
      throw new Error('Inconsistent holiday session.');
    }
    return { row: { date, exchange: raw.exchange, status: raw.status, open, close }, issues };
  }, rows => rows.sort((a, b) => a.date.localeCompare(b.date) || a.exchange.localeCompare(b.exchange)), () => null, true);
}

export function normalizeTreasuryRate(raw: unknown, metadata: MarketDataMetadata): DataResult<TreasuryRate> {
  return collect(raw, metadata, value => {
    const raw = requiredRecord(value);
    const date = parseDate(raw.date);
    const rate = number(raw.yield_1_month);
    if (rate === null) throw new Error('Missing one-month yield.');
    return { row: { date, annualRate: rate / 100 }, issues: [] };
  }, rows => rows.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 1), rows => rows[0]?.date ?? null);
}

export type MarketDataKind = 'dailyBars' | 'optionChain' | 'contract' | 'holidays' | 'oneMonthTreasury';

export type MarketDataRows = {
  dailyBars: DailyBar;
  optionChain: OptionSnapshot;
  contract: OptionSnapshot;
  holidays: MarketHoliday;
  oneMonthTreasury: TreasuryRate;
};

function dtoObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const data = requiredRecord(value);
  const prototype: unknown = Object.getPrototypeOf(data);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('Invalid DTO.');
  const ownKeys = Reflect.ownKeys(data);
  if (ownKeys.length !== keys.length || !keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(data, key);
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor;
  })) throw new Error('Invalid DTO.');
  return data;
}

function dtoNumber(value: unknown, minimum = -Infinity, maximum = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error('Invalid DTO number.');
  }
  return value;
}

function dtoNullableNumber(value: unknown, minimum = -Infinity, maximum = Infinity): number | null {
  return value === null ? null : dtoNumber(value, minimum, maximum);
}

function dtoTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('Invalid DTO timestamp.');
  }
  return value;
}

function dtoNullableTimestamp(value: unknown): string | null {
  return value === null ? null : dtoTimestamp(value);
}

function dtoSymbol(value: unknown): string {
  const symbol = parseSymbol(value);
  if (symbol !== value) throw new Error('Noncanonical DTO symbol.');
  return symbol;
}

function decodeDailyBar(value: unknown): DailyBar {
  const data = dtoObject(value, ['symbol', 'date', 'open', 'high', 'low', 'close', 'volume', 'startedAt', 'provisional']);
  const symbol = dtoSymbol(data.symbol);
  const date = parseDate(data.date);
  const open = dtoNumber(data.open, 0), high = dtoNumber(data.high, 0);
  const low = dtoNumber(data.low, 0), close = dtoNumber(data.close, 0);
  const volume = dtoNullableNumber(data.volume, 0);
  const startedAt = dtoTimestamp(data.startedAt);
  if (low <= 0 || low > high || open < low || open > high || close < low || close > high
    || sessionDate(startedAt) !== date || typeof data.provisional !== 'boolean') throw new Error('Invalid DTO bar.');
  return { symbol, date, open, high, low, close, volume, startedAt, provisional: data.provisional };
}

function decodeOptionSnapshot(value: unknown): OptionSnapshot {
  const data = dtoObject(value, ['occ', 'symbol', 'expiry', 'side', 'strike', 'bid', 'ask', 'iv', 'greeks', 'openInterest', 'volume', 'quotedAt']);
  const identity = parseOcc(data.occ);
  if (identity.occ !== data.occ || identity.symbol !== data.symbol || identity.expiry !== data.expiry
    || identity.side !== data.side || identity.strike !== data.strike) throw new Error('Invalid DTO option identity.');
  const bid = dtoNullableNumber(data.bid, 0), ask = dtoNullableNumber(data.ask, 0);
  const iv = dtoNullableNumber(data.iv, 0);
  if ((bid !== null && ask !== null && bid > ask) || iv === 0) throw new Error('Invalid DTO quote.');
  const rawGreeks = dtoObject(data.greeks, ['delta', 'gamma', 'theta', 'vega']);
  const greeks = { delta: dtoNullableNumber(rawGreeks.delta, -1, 1), gamma: dtoNullableNumber(rawGreeks.gamma, 0),
    theta: dtoNullableNumber(rawGreeks.theta), vega: dtoNullableNumber(rawGreeks.vega, 0) };
  return { ...identity, bid, ask, iv, greeks, openInterest: dtoNullableNumber(data.openInterest, 0),
    volume: dtoNullableNumber(data.volume, 0), quotedAt: dtoNullableTimestamp(data.quotedAt) };
}

function decodeHoliday(value: unknown): MarketHoliday {
  const data = dtoObject(value, ['date', 'exchange', 'status', 'open', 'close']);
  const date = parseDate(data.date);
  if (typeof data.exchange !== 'string' || !/^[A-Za-z][A-Za-z0-9 .-]{0,39}$/.test(data.exchange)
    || data.exchange.trim() !== data.exchange || (data.status !== 'closed' && data.status !== 'early-close')) {
    throw new Error('Invalid DTO holiday.');
  }
  const open = dtoNullableTimestamp(data.open), close = dtoNullableTimestamp(data.close);
  if ((open !== null && sessionDate(open) !== date) || (close !== null && sessionDate(close) !== date)
    || (open !== null && close !== null && open >= close)) throw new Error('Invalid DTO holiday times.');
  return { date, exchange: data.exchange, status: data.status, open, close };
}

function decodeTreasury(value: unknown): TreasuryRate {
  const data = dtoObject(value, ['date', 'annualRate']);
  return { date: parseDate(data.date), annualRate: dtoNumber(data.annualRate) };
}

const dtoRowDecoders: { [K in MarketDataKind]: (value: unknown) => MarketDataRows[K] } = {
  dailyBars: decodeDailyBar,
  optionChain: decodeOptionSnapshot,
  contract: decodeOptionSnapshot,
  holidays: decodeHoliday,
  oneMonthTreasury: decodeTreasury,
};

function dtoMissingFields(row: MarketDataRows[MarketDataKind]): boolean {
  if ('occ' in row) return [row.bid, row.ask, row.iv, row.openInterest, row.volume, row.quotedAt,
    ...Object.values(row.greeks)].some(value => value === null);
  if ('provisional' in row) return row.volume === null;
  if ('exchange' in row) return row.status === 'early-close' && (row.open === null || row.close === null);
  return false;
}

export function decodeDataResult<K extends MarketDataKind>(kind: K, value: unknown): DataResult<MarketDataRows[K]> {
  try {
    const data = dtoObject(value, ['provider', 'asOf', 'fetchedAt', 'source', 'status', 'rows', 'issues']);
    if (data.provider !== 'massive' || (data.source !== 'network' && data.source !== 'cache')
      || !Array.isArray(data.rows) || data.rows.length > 2000 || !Array.isArray(data.issues) || data.issues.length > 128) {
      throw new Error('Invalid DTO metadata.');
    }
    const fetchedAt = dtoTimestamp(data.fetchedAt);
    const asOf = data.asOf === null ? null
      : kind === 'oneMonthTreasury' && typeof data.asOf === 'string' && data.asOf.length === 10
        ? parseDate(data.asOf) : dtoTimestamp(data.asOf);
    const issues: string[] = [];
    for (const issue of data.issues) {
      if (typeof issue !== 'string' || issue.length < 1 || issue.length > 512 || issue.trim() !== issue
        || /[\u0000-\u001f\u007f]/.test(issue)) throw new Error('Invalid DTO issue.');
      issues.push(issue);
    }
    if (!Object.hasOwn(dtoRowDecoders, kind)) throw new Error('Invalid DTO kind.');
    const decodeRow = dtoRowDecoders[kind];
    const rows: MarketDataRows[K][] = [];
    for (const row of data.rows) rows.push(decodeRow(row));
    if ((kind === 'optionChain' || kind === 'contract') && rows.some(row => 'quotedAt' in row
      && row.quotedAt !== null && optionQuoteTime(row.quotedAt, fetchedAt) === null)) {
      throw new Error('Invalid DTO quote time.');
    }
    if (kind === 'dailyBars' && rows.some(row => 'provisional' in row
      && (row.provisional !== (row.date === sessionDate(fetchedAt)) || row.date > sessionDate(fetchedAt)))) {
      throw new Error('Invalid DTO session date.');
    }
    if ((kind === 'contract' || kind === 'oneMonthTreasury') && rows.length > 1) throw new Error('Invalid DTO row count.');
    const base = { provider: 'massive', fetchedAt, asOf, source: data.source, issues } satisfies Omit<DataResult<never>, 'status' | 'rows'>;
    let result: DataResult<MarketDataRows[K]>;
    switch (data.status) {
      case 'ok':
        if (!rows.length || issues.length || rows.some(dtoMissingFields)) throw new Error('Invalid successful DTO.');
        result = { ...base, status: 'ok', rows };
        break;
      case 'partial':
        if (!issues.length) throw new Error('Invalid partial DTO.');
        result = { ...base, status: 'partial', rows };
        break;
      case 'empty':
        if (rows.length || issues.length) throw new Error('Invalid empty DTO.');
        result = { ...base, status: 'empty', rows: [] };
        break;
      case 'error':
      case 'unavailable':
        if (rows.length || !issues.length || asOf !== null) throw new Error('Invalid failed DTO.');
        result = { ...base, status: data.status, rows: [] };
        break;
      default:
        throw new Error('Invalid DTO status.');
    }
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength >= 900_000) throw new Error('Oversized DTO.');
    return result;
  } catch {
    throw new Error('Invalid market data result.');
  }
}
