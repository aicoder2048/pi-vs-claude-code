import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContractQuery, DailyBarsQuery, DataResult, OptionChainQuery } from '../types.ts';
import {
  decodeDataResult, parseContractQuery, parseDailyBarsQuery, parseDate, parseOptionChainQuery,
  type MarketDataKind, type MarketDataRows,
} from './normalize.ts';

const MAX_BYTES = 900_000;
const MAX_ENTRIES = 128;

type CacheQuery =
  | { kind: 'dailyBars'; value: DailyBarsQuery & { from?: string; to?: string } }
  | { kind: 'optionChain'; value: OptionChainQuery }
  | { kind: 'contract'; value: ContractQuery }
  | { kind: 'holidays' | 'oneMonthTreasury'; value: Record<string, never> };

function queryObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cache query.');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('Invalid cache query.');
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw new Error('Invalid cache query.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Invalid cache query.');
    entries.push([key, descriptor.value]);
  }
  return Object.fromEntries(entries);
}

function canonicalQuery(kind: MarketDataKind, value: unknown): CacheQuery {
  switch (kind) {
    case 'dailyBars': {
      const data = queryObject(value, ['symbol', 'days', 'from', 'to']);
      const query: DailyBarsQuery & { from?: string; to?: string } = parseDailyBarsQuery(data);
      if (data.from !== undefined) query.from = parseDate(data.from);
      if (data.to !== undefined) query.to = parseDate(data.to);
      if (query.from !== undefined && query.to !== undefined && query.from > query.to) throw new Error('Invalid cache date range.');
      return { kind, value: query };
    }
    case 'optionChain': {
      const data = queryObject(value, ['symbol', 'expiry', 'side', 'strikeRange']);
      if (data.strikeRange !== undefined) queryObject(data.strikeRange, ['min', 'max']);
      return { kind, value: parseOptionChainQuery(data) };
    }
    case 'contract':
      return { kind, value: parseContractQuery(queryObject(value, ['occ'])) };
    case 'holidays':
    case 'oneMonthTreasury':
      queryObject(value, []);
      return { kind, value: {} };
    default:
      throw new Error('Invalid cache kind.');
  }
}

function matchesQuery(query: CacheQuery, result: DataResult<MarketDataRows[MarketDataKind]>): boolean {
  const times = result.rows.map(row => 'startedAt' in row ? row.startedAt : 'quotedAt' in row ? row.quotedAt
    : 'annualRate' in row ? row.date : null).filter(time => time !== null).sort();
  if (result.asOf !== (times.at(-1) ?? null)) return false;
  switch (query.kind) {
    case 'dailyBars': {
      const { symbol, days, from, to } = query.value;
      if (result.rows.length > days || result.status === 'ok' && result.rows.length !== days) return false;
      let previous: string | null = null;
      for (const row of result.rows) {
        if (!('provisional' in row) || row.symbol !== symbol || (from !== undefined && row.date < from)
          || (to !== undefined && row.date > to) || (previous !== null && previous >= row.date)) return false;
        previous = row.date;
      }
      return true;
    }
    case 'optionChain': {
      const { symbol, expiry, side, strikeRange } = query.value;
      return result.rows.every(row => 'occ' in row && row.symbol === symbol
        && (expiry === undefined || row.expiry === expiry)
        && (side === undefined || row.side === side)
        && (strikeRange === undefined || (row.strike >= strikeRange.min && row.strike <= strikeRange.max)));
    }
    case 'contract':
      return result.rows.every(row => 'occ' in row && row.occ === query.value.occ);
    case 'holidays':
    case 'oneMonthTreasury':
      return true;
  }
}

function cacheName(query: CacheQuery): string {
  return `${createHash('sha256').update(JSON.stringify(query)).digest('hex')}.json`;
}

function envelopeObject(value: unknown): Record<string, unknown> {
  const data = queryObject(value, ['version', 'kind', 'query', 'fetchedAt', 'result']);
  if (Object.keys(data).length !== 5) throw new Error('Invalid cache envelope.');
  return data;
}

export class MarketDataCache {
  private readonly cacheDir: string;
  private readonly now: () => number;
  private readonly writes = new Map<string, Promise<boolean>>();

  constructor(options: { cacheDir: string; now: () => number }) {
    this.cacheDir = options.cacheDir;
    this.now = options.now;
  }

  async get<K extends MarketDataKind>(kind: K, query: unknown, ttlMs: number): Promise<DataResult<MarketDataRows[K]> | null> {
    try {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) return null;
      const canonical = canonicalQuery(kind, query);
      const text = await this.readBounded(join(this.cacheDir, cacheName(canonical)));
      if (text === null) return null;
      const raw: unknown = JSON.parse(text);
      const envelope = envelopeObject(raw);
      if (envelope.version !== 1 || envelope.kind !== kind
        || JSON.stringify(envelope.query) !== JSON.stringify(canonical.value)) return null;
      const result = decodeDataResult(kind, envelope.result);
      if ((result.status !== 'ok' && result.status !== 'empty') || envelope.fetchedAt !== result.fetchedAt
        || !matchesQuery(canonical, result)) return null;
      const now = this.now();
      const age = now - Date.parse(result.fetchedAt);
      if (!Number.isFinite(now) || age < 0 || age >= ttlMs) return null;
      return { ...result, source: 'cache' };
    } catch {
      return null;
    }
  }

  async put<K extends MarketDataKind>(kind: K, query: unknown, result: DataResult<MarketDataRows[K]>, signal?: AbortSignal): Promise<boolean> {
    let name: string;
    try { name = cacheName(canonicalQuery(kind, query)); } catch { return false; }
    const previous = this.writes.get(name) ?? Promise.resolve(true);
    const pending = previous.then(() => this.write(kind, query, result, signal));
    this.writes.set(name, pending);
    try {
      return await pending;
    } finally {
      if (this.writes.get(name) === pending) this.writes.delete(name);
    }
  }

  private async write<K extends MarketDataKind>(kind: K, query: unknown, result: DataResult<MarketDataRows[K]>, signal?: AbortSignal): Promise<boolean> {
    let temporary: string | null = null;
    try {
      if (signal?.aborted) return false;
      const canonical = canonicalQuery(kind, query);
      const decoded = decodeDataResult(kind, result);
      const now = this.now();
      if ((decoded.status !== 'ok' && decoded.status !== 'empty') || !Number.isFinite(now)
        || Date.parse(decoded.fetchedAt) > now || !matchesQuery(canonical, decoded)) return false;
      const text = JSON.stringify({ version: 1, kind, query: canonical.value, fetchedAt: decoded.fetchedAt, result: decoded });
      if (new TextEncoder().encode(text).byteLength >= MAX_BYTES) return false;
      await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
      const name = cacheName(canonical);
      const temporaryPath = join(this.cacheDir, `.${name}.${randomUUID()}.tmp`);
      const file = await open(temporaryPath, 'wx', 0o600);
      temporary = temporaryPath;
      try {
        await file.writeFile(text, 'utf8');
      } finally {
        await file.close();
      }
      if (signal?.aborted) return false;
      await rename(temporaryPath, join(this.cacheDir, name));
      temporary = null;
      await this.prune().catch(() => {});
      return true;
    } catch {
      return false;
    } finally {
      if (temporary !== null) await unlink(temporary).catch(() => {});
    }
  }

  private async readBounded(path: string): Promise<string | null> {
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size <= 0 || info.size >= MAX_BYTES) return null;
      const buffer = new Uint8Array(MAX_BYTES);
      let total = 0;
      while (total < MAX_BYTES) {
        const { bytesRead } = await file.read(buffer, total, MAX_BYTES - total, total);
        if (bytesRead === 0) return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total));
        total += bytesRead;
      }
      return null;
    } finally {
      await file.close();
    }
  }

  private async prune(): Promise<void> {
    const names = (await readdir(this.cacheDir)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    if (names.length <= MAX_ENTRIES) return;
    const entries = await Promise.all(names.map(async name => {
      try {
        const info = await stat(join(this.cacheDir, name));
        return info.isFile() ? { name, modified: info.mtimeMs } : null;
      } catch {
        return null;
      }
    }));
    const ordered = entries.filter(entry => entry !== null)
      .sort((left, right) => left.modified - right.modified || left.name.localeCompare(right.name));
    await Promise.all(ordered.slice(0, Math.max(0, ordered.length - MAX_ENTRIES))
      .map(entry => unlink(join(this.cacheDir, entry.name)).catch(() => {})));
  }
}
