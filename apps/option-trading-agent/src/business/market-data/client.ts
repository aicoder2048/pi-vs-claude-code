import { open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ContractQuery, DailyBar, DailyBarsQuery, DataResult, MarketDataMetadata, MarketHoliday,
  OptionChainQuery, OptionSnapshot, TreasuryRate,
} from '../types.ts';
import { MarketDataCache } from './cache.ts';
import {
  decodeDataResult, millisecondsToIso, normalizeContract, normalizeDailyBars, normalizeMarketHolidays,
  normalizeOptionChain, normalizeTreasuryRate, parseContractQuery, parseDailyBarsQuery,
  parseOcc, parseOptionChainQuery, type MarketDataKind, type MarketDataRows,
} from './normalize.ts';

export const MARKET_DATA_ENV_FILE = '/Users/szou/Python/Playground/ClaudeTradingSkills/data/polygon/.env';
export const MAX_RESPONSE_BYTES = 512_000;
const ORIGIN = 'https://api.polygon.io';
const MAX_ROWS = 1000;
const MAX_FLIGHTS = 128;
const HOUR = 3_600_000;
const nyDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
const nyTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

type MarketFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface MarketDataOptions {
  fetch?: MarketFetch;
  now?: () => number;
  cacheDir?: string;
  getApiKey?: () => string | null | undefined | Promise<string | null | undefined>;
  maxHttpRequests?: number;
  maxPages?: number;
  timeout?: number;
}

type RequestSpec<K extends MarketDataKind> = {
  kind: K;
  query: unknown;
  url: URL;
  paged: boolean;
  ttlMs: number;
  normalize: (raw: unknown, metadata: MarketDataMetadata) => DataResult<MarketDataRows[K]>;
};
type Flight = { controller: AbortController; consumers: Set<symbol>; result: Promise<unknown> };
type HttpResult = { kind: 'data'; value: unknown }
  | { kind: 'failure'; status: 'unavailable' | 'error'; issue: string };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function failure<T>(now: () => number, status: 'unavailable' | 'error', issue: string): DataResult<T> {
  return { provider: 'massive', asOf: null, fetchedAt: new Date(now()).toISOString(), source: 'network',
    status, rows: [], issues: [issue] };
}

function validKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

export async function loadCanonicalApiKey(): Promise<string | null> {
  try {
    const override = process.env.MARKET_DATA_ENV_FILE;
    if (override !== undefined && resolve(override) !== MARKET_DATA_ENV_FILE) return null;
    if (await realpath(MARKET_DATA_ENV_FILE) !== MARKET_DATA_ENV_FILE) return null;
    const file = await open(MARKET_DATA_ENV_FILE, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 16_384) return null;
      const buffer = new Uint8Array(16_385);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 16_384) return null;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
      const lines = text.split(/\r?\n/).filter(line => /^\s*(?:export\s+)?POLYGON_API_KEY\s*=/.test(line));
      if (lines.length !== 1) return null;
      const match = /^\s*(?:export\s+)?POLYGON_API_KEY\s*=\s*(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z0-9_-]+))\s*(?:#.*)?$/.exec(lines[0]);
      const key = match?.[1] ?? match?.[2] ?? match?.[3];
      return validKey(key) ? key : null;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

function endpoint(path: string, params: Record<string, string> = {}): URL {
  const url = new URL(path, ORIGIN);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

function continuation(value: unknown, initial: URL): URL | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.origin !== ORIGIN || url.pathname !== initial.pathname || url.username || url.password || url.hash) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:api_?key|token|access_token|authorization)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url;
  } catch {
    return null;
  }
}

function declaredEmpty(raw: unknown, kind: MarketDataKind): unknown {
  const data = record(raw);
  if (!data || 'results' in data || data.error) return raw;
  const counts = [data.resultsCount, data.count].filter(count => count !== undefined);
  if ((data.status === 'OK' || data.status === 'DELAYED' || data.status === 'PARTIAL' || data.status === 'EMPTY')
    && (counts.length > 0 && counts.every(count => count === 0) || data.status === 'EMPTY' && counts.length === 0)) {
    return { ...data, results: kind === 'contract' ? null : [] };
  }
  return raw;
}

function dailyTtl(now: number): number {
  const parts = nyTime.formatToParts(now);
  const weekday = parts.find(part => part.type === 'weekday')?.value;
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  const minute = Number(parts.find(part => part.type === 'minute')?.value);
  return weekday !== 'Sat' && weekday !== 'Sun' && hour * 60 + minute >= 570 && hour < 16 ? 60_000 : 4 * HOUR;
}

export class MarketData {
  private readonly fetcher: MarketFetch;
  private readonly now: () => number;
  private readonly getApiKey: NonNullable<MarketDataOptions['getApiKey']>;
  private readonly cache: MarketDataCache;
  private readonly maxPages: number;
  private readonly maxHttpRequests: number;
  private readonly timeout: number;
  private readonly flights = new Map<string, Flight>();
  private requests = 0;

  constructor(options: MarketDataOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.getApiKey = options.getApiKey ?? loadCanonicalApiKey;
    this.maxPages = options.maxPages ?? 4;
    this.maxHttpRequests = options.maxHttpRequests ?? Infinity;
    this.timeout = options.timeout ?? 10_000;
    if (!Number.isInteger(this.maxPages) || this.maxPages < 1 || this.maxPages > 4
      || !(this.maxHttpRequests === Infinity || Number.isSafeInteger(this.maxHttpRequests) && this.maxHttpRequests >= 0)
      || !Number.isFinite(this.timeout) || this.timeout <= 0 || this.timeout > 120_000) {
      throw new Error('Invalid market data limits.');
    }
    this.cache = new MarketDataCache({ cacheDir: options.cacheDir ?? fileURLToPath(new URL('../../../.local/data/', import.meta.url)), now: this.now });
  }

  get httpRequests(): number { return this.requests; }

  dailyBars(query: DailyBarsQuery, signal?: AbortSignal): Promise<DataResult<DailyBar>> {
    try {
      const parsed = parseDailyBarsQuery(query);
      const to = nyDate.format(this.now());
      const from = new Date(Date.parse(`${to}T00:00:00.000Z`) - (Math.ceil(parsed.days * 7 / 5) + 45) * 86_400_000)
        .toISOString().slice(0, 10);
      return this.shared({ kind: 'dailyBars', query: { ...parsed, from, to }, paged: true, ttlMs: dailyTtl(this.now()),
        url: endpoint(`/v2/aggs/ticker/${parsed.symbol}/range/1/day/${from}/${to}`, { adjusted: 'true', sort: 'asc', limit: '1000' }),
        normalize: (raw, meta) => normalizeDailyBars(raw, parsed, meta) }, signal);
    } catch {
      return Promise.resolve(failure(this.now, 'error', 'Invalid daily bars query.'));
    }
  }

  optionChain(query: OptionChainQuery, signal?: AbortSignal): Promise<DataResult<OptionSnapshot>> {
    try {
      const parsed = parseOptionChainQuery(query);
      const params: Record<string, string> = { limit: '250' };
      if (parsed.expiry !== undefined) params.expiration_date = parsed.expiry;
      if (parsed.side !== undefined) params.contract_type = parsed.side;
      if (parsed.strikeRange !== undefined) {
        params['strike_price.gte'] = String(parsed.strikeRange.min);
        params['strike_price.lte'] = String(parsed.strikeRange.max);
      }
      return this.shared({ kind: 'optionChain', query: parsed, paged: true, ttlMs: 30_000,
        url: endpoint(`/v3/snapshot/options/${parsed.symbol}`, params),
        normalize: (raw, meta) => normalizeOptionChain(raw, parsed, meta) }, signal);
    } catch {
      return Promise.resolve(failure(this.now, 'error', 'Invalid option chain query.'));
    }
  }

  contract(query: ContractQuery, signal?: AbortSignal): Promise<DataResult<OptionSnapshot>> {
    try {
      const parsed = parseContractQuery(query);
      const identity = parseOcc(parsed.occ);
      return this.shared({ kind: 'contract', query: parsed, paged: false, ttlMs: 30_000,
        url: endpoint(`/v3/snapshot/options/${identity.symbol}/${identity.occ}`),
        normalize: (raw, meta) => normalizeContract(raw, parsed, meta) }, signal);
    } catch {
      return Promise.resolve(failure(this.now, 'error', 'Invalid contract query.'));
    }
  }

  holidays(signal?: AbortSignal): Promise<DataResult<MarketHoliday>> {
    return this.shared({ kind: 'holidays', query: {}, paged: false, ttlMs: 24 * HOUR,
      url: endpoint('/v1/marketstatus/upcoming'), normalize: normalizeMarketHolidays }, signal);
  }

  oneMonthTreasury(signal?: AbortSignal): Promise<DataResult<TreasuryRate>> {
    return this.shared({ kind: 'oneMonthTreasury', query: {}, paged: true, ttlMs: 6 * HOUR,
      url: endpoint('/fed/v1/treasury-yields', { sort: 'date.desc', limit: '1' }), normalize: normalizeTreasuryRate }, signal);
  }

  private shared<K extends MarketDataKind>(spec: RequestSpec<K>, signal?: AbortSignal): Promise<DataResult<MarketDataRows[K]>> {
    if (signal?.aborted) return Promise.resolve(failure(this.now, 'error', 'Market data request cancelled.'));
    const key = JSON.stringify([spec.kind, spec.query]);
    let flight = this.flights.get(key);
    if (!flight) {
      if (this.flights.size >= MAX_FLIGHTS) return Promise.resolve(failure(this.now, 'error', 'Too many active market queries.'));
      const controller = new AbortController();
      const created: Flight = { controller, consumers: new Set(), result: Promise.resolve(null) };
      created.result = Promise.resolve().then(() => this.execute(spec, controller.signal))
        .catch(() => failure(this.now, 'error', 'Market data request failed.'))
        .finally(() => { if (this.flights.get(key) === created) this.flights.delete(key); });
      this.flights.set(key, created);
      flight = created;
    }
    const active = flight;
    const consumer = Symbol();
    active.consumers.add(consumer);
    return new Promise(resolveResult => {
      let settled = false;
      const finish = (result: DataResult<MarketDataRows[K]>) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        active.consumers.delete(consumer);
        resolveResult(structuredClone(result));
      };
      const abort = () => {
        finish(failure(this.now, 'error', 'Market data request cancelled.'));
        if (!active.consumers.size) {
          if (this.flights.get(key) === active) this.flights.delete(key);
          active.controller.abort();
        }
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      void active.result.then(value => {
        try { finish(decodeDataResult(spec.kind, value)); }
        catch { finish(failure(this.now, 'error', 'Invalid market data result.')); }
      });
    });
  }

  private async execute<K extends MarketDataKind>(spec: RequestSpec<K>, signal: AbortSignal): Promise<DataResult<MarketDataRows[K]>> {
    let cached = await this.cache.get(spec.kind, spec.query, spec.ttlMs);
    if (cached && spec.kind === 'dailyBars' && cached.rows.some(row => 'provisional' in row && row.provisional)) {
      cached = await this.cache.get(spec.kind, spec.query, Math.min(spec.ttlMs, 60_000));
    }
    if (signal.aborted) return failure(this.now, 'error', 'Market data request cancelled.');
    if (cached) return cached;
    let key: string | null | undefined;
    try { key = await this.getApiKey(); } catch { key = null; }
    if (!validKey(key)) return failure(this.now, 'unavailable', 'Market data credentials are unavailable.');
    const metadata: MarketDataMetadata = { fetchedAt: new Date(this.now()).toISOString(), source: 'network' };
    const rawRows: unknown[] = [];
    const visited = new Set<string>();
    const issues: string[] = [];
    let providerPartial = false;
    let pages = 0;
    let url = spec.url;
    let result: DataResult<MarketDataRows[K]>;
    while (true) {
      if (signal.aborted) return failure(this.now, 'error', 'Market data request cancelled.');
      visited.add(url.href);
      const response = await this.http(url, key, signal);
      if (response.kind === 'failure') {
        if (!pages) return failure(this.now, response.status, response.issue);
        issues.push(response.issue);
        break;
      }
      const raw = declaredEmpty(response.value, spec.kind);
      if (!spec.paged) {
        result = spec.normalize(raw, metadata);
        const body = record(raw);
        if (body?.next_url && (result.status === 'ok' || result.status === 'empty' || result.status === 'partial')) {
          result = { ...result, status: 'partial', issues: [...new Set([...result.issues, 'Additional provider pages remain.'])] };
        }
        return this.persist(spec, result, signal);
      }
      const body = record(raw);
      const status = typeof body?.status === 'string' ? body.status.toUpperCase() : body?.status;
      const normalized = spec.normalize(raw, metadata);
      if (!body || !Array.isArray(body.results)
        || normalized.status === 'unavailable'
        || (status !== undefined && !['OK', 'DELAYED', 'PARTIAL', 'EMPTY'].includes(String(status))) || body.error
        || (spec.kind === 'dailyBars' && body.ticker !== undefined && body.ticker !== record(spec.query)?.symbol)) {
        if (!pages) return normalized.status === 'unavailable' ? normalized
          : failure(this.now, 'error', 'Malformed provider payload.');
        issues.push('A later provider page failed validation.');
        break;
      }
      if (spec.kind === 'dailyBars') {
        const range = record(spec.query);
        if (body.results.some(value => {
          const startedAt = millisecondsToIso(record(value)?.t);
          const date = startedAt === null ? null : nyDate.format(new Date(startedAt));
          return date !== null && typeof range?.from === 'string' && typeof range.to === 'string'
            && (date < range.from || date > range.to);
        })) {
          if (!pages) return failure(this.now, 'error', 'Provider daily sessions do not match requested date range.');
          issues.push('A later daily page contains out-of-range sessions.');
          break;
        }
      }
      pages++;
      providerPartial ||= status === 'PARTIAL';
      const available = MAX_ROWS - rawRows.length;
      rawRows.push(...body.results.slice(0, available));
      if (body.results.length > available) { issues.push('Provider row limit reached.'); break; }
      if (body.next_url === undefined || body.next_url === null || body.next_url === '') break;
      const next = continuation(body.next_url, spec.url);
      if (!next || visited.has(next.href)) { issues.push('Unsafe or repeated provider pagination stopped.'); break; }
      if (pages >= this.maxPages) { issues.push('Provider page limit reached.'); break; }
      url = next;
    }
    result = spec.normalize({ status: providerPartial ? 'PARTIAL' : 'OK', results: rawRows }, metadata);
    if (issues.length) result = { ...result, status: 'partial', issues: [...new Set([...result.issues, ...issues])] };
    return this.persist(spec, result, signal);
  }

  private async persist<K extends MarketDataKind>(spec: RequestSpec<K>, value: DataResult<MarketDataRows[K]>, signal: AbortSignal): Promise<DataResult<MarketDataRows[K]>> {
    if (signal.aborted) return failure(this.now, 'error', 'Market data request cancelled.');
    const result = decodeDataResult(spec.kind, value);
    if ((result.status === 'ok' || result.status === 'empty') && !await this.cache.put(spec.kind, spec.query, result, signal)) {
      return { ...result, status: 'partial', issues: ['Market data cache write failed.'] };
    }
    return signal.aborted ? failure(this.now, 'error', 'Market data request cancelled.') : result;
  }

  private async http(url: URL, key: string, parent: AbortSignal): Promise<HttpResult> {
    if (this.requests >= this.maxHttpRequests) return { kind: 'failure', status: 'unavailable', issue: 'Market data HTTP request budget exhausted.' };
    if (parent.aborted) return { kind: 'failure', status: 'error', issue: 'Market data request cancelled.' };
    const controller = new AbortController();
    let expired = false;
    let rejectAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new Error('Request aborted.')); });
    const abort = () => { controller.abort(); rejectAbort?.(); };
    parent.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { expired = true; abort(); }, this.timeout);
    try {
      this.requests++;
      const run = async (): Promise<HttpResult> => {
        const response = await this.fetcher(url.href, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
          redirect: 'error', signal: controller.signal });
        if (response.redirected || response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => {});
          return { kind: 'failure', status: 'error', issue: 'Provider redirect rejected.' };
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return { kind: 'failure', status: [401, 402, 403, 429].includes(response.status) ? 'unavailable' : 'error',
            issue: [401, 402, 403, 429].includes(response.status) ? 'Provider data is unavailable.' : 'Provider HTTP request failed.' };
        }
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
          await response.body?.cancel().catch(() => {});
          return { kind: 'failure', status: 'error', issue: 'Provider response size limit exceeded.' };
        }
        if (!response.body) return { kind: 'failure', status: 'error', issue: 'Missing provider response body.' };
        const reader = response.body.getReader();
        const cancel = () => { void reader.cancel().catch(() => {}); };
        controller.signal.addEventListener('abort', cancel, { once: true });
        let bytes = 0;
        let text = '';
        const decoder = new TextDecoder('utf-8', { fatal: true });
        try {
          while (true) {
            const chunk = await reader.read();
            if (controller.signal.aborted) throw new Error('Request aborted.');
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) {
              await reader.cancel();
              return { kind: 'failure', status: 'error', issue: 'Provider response size limit exceeded.' };
            }
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
          const value: unknown = JSON.parse(text);
          return { kind: 'data', value };
        } finally {
          controller.signal.removeEventListener('abort', cancel);
          reader.releaseLock();
        }
      };
      return await Promise.race([run(), aborted]);
    } catch {
      return { kind: 'failure', status: 'error', issue: expired ? 'Provider request timed out.'
        : parent.aborted ? 'Market data request cancelled.' : 'Provider request or response failed.' };
    } finally {
      clearTimeout(timer);
      parent.removeEventListener('abort', abort);
    }
  }
}
