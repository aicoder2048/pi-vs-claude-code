import { describe, expect, test } from 'bun:test';
import {
  decodeDataResult, millisecondsToIso, nanosecondsToIso, normalizeContract, normalizeDailyBars,
  normalizeMarketHolidays, normalizeOptionChain, normalizeTreasuryRate,
  parseContractQuery, parseDailyBarsQuery, parseDate, parseOcc, parseOptionChainQuery, parseSymbol,
} from '../src/business/market-data/normalize.ts';
import bars from './fixtures/market/daily-bars.json';
import chain from './fixtures/market/option-chain.json';
import callsBeforePuts from './fixtures/market/calls-before-puts.ts';
import contract from './fixtures/market/contract.json';
import holidays from './fixtures/market/holidays.json';
import treasury from './fixtures/market/treasury.json';

const metadata: Parameters<typeof normalizeDailyBars>[2] = {
  fetchedAt: '2026-10-31T00:30:00.000Z', source: 'network',
};
const barsQuery = parseDailyBarsQuery({ symbol: 'NIMB', days: 4 });
const chainQuery = parseOptionChainQuery({ symbol: 'NIMB' });
const contractQuery = parseContractQuery({ occ: 'O:NIMB261106P00100000' });
const option = contract.results;

function without(row: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([name]) => name !== key));
}

const endpoints = [
  { name: 'daily bars', valid: bars, empty: { status: 'OK', results: [] },
    run: (raw: unknown, meta = metadata) => normalizeDailyBars(raw, barsQuery, meta) },
  { name: 'option chain', valid: chain, empty: { status: 'OK', results: [] },
    run: (raw: unknown, meta = metadata) => normalizeOptionChain(raw, chainQuery, meta) },
  { name: 'contract', valid: contract, empty: { status: 'OK', results: null },
    run: (raw: unknown, meta = metadata) => normalizeContract(raw, contractQuery, meta) },
  { name: 'holidays', valid: holidays, empty: [],
    run: (raw: unknown, meta = metadata) => normalizeMarketHolidays(raw, meta) },
  { name: 'treasury', valid: treasury, empty: { status: 'OK', results: [] },
    run: (raw: unknown, meta = metadata) => normalizeTreasuryRate(raw, meta) },
];

describe('market query boundary', () => {
  test.each(['nimb', 'BRK.B', 'ABC-1', '9XYZ', 'ABCDEFGHIJKLMNOP'])('canonicalizes safe symbol %s', value => {
    expect(parseSymbol(value)).toBe(value.toUpperCase());
  });
  test.each([undefined, null, 7, {}, [], '', '.ABC', '-ABC', 'A B', 'A\tB', 'A\nB', 'A/B', '../NIMB',
    'NIMB?apiKey=fictional', 'NIMB\0', 'NIMB\n', ' NIMB', 'ABCDEFGHIJKLMNOPQ', '股票', 'NIMB_%'].map(value => ({ value })))('rejects unsafe symbol $value', ({ value }) => {
    expect(() => parseSymbol(value)).toThrow(Error);
  });
  test.each(['2024-02-29', '2026-11-06', '2000-02-29'])('accepts calendar date %s', value => {
    expect(parseDate(value)).toBe(value);
  });
  test.each([null, undefined, 20261106, {}, '', '2026-2-03', '2026-02-29', '2026-04-31', '1900-02-29',
    '2026-00-01', '2026-13-01', '2026-01-00', '2026-01-32', '2026-11-06T00:00:00Z', '2026-11-06\n'].map(value => ({ value })))('rejects invalid date $value', ({ value }) => {
    expect(() => parseDate(value)).toThrow(Error);
  });
  test('decodes OCC strikes in thousandths and always includes the provider prefix', () => {
    expect(parseOcc('NIMB261106P00100500')).toEqual({
      occ: 'O:NIMB261106P00100500', symbol: 'NIMB', expiry: '2026-11-06', side: 'put', strike: 100.5,
    });
    expect(parseOcc('O:NIMB261106C00105000')).toEqual({
      occ: 'O:NIMB261106C00105000', symbol: 'NIMB', expiry: '2026-11-06', side: 'call', strike: 105,
    });
    expect(parseOcc('O:NIMB240229C00001250').expiry).toBe('2024-02-29');
  });
  test.each([undefined, null, 5, {}, '', 'O:NIMB260229P00100000', 'O:NIMB261131P00100000',
    'O:NIMB261300P00100000', 'O:NIMB261106X00100000', 'O:NIMB261106P0010000',
    'O:NIMB261106P001000000', 'O:NI MB261106P00100000', 'O:../NIMB261106P00100000',
    'O:NIMB261106P00100000?secret=fictional', 'O:NIMB261106P00100000\n'].map(value => ({ value })))('rejects malformed OCC $value', ({ value }) => {
    expect(() => parseOcc(value)).toThrow(Error);
  });
  test('parses daily bars with required bounded integer days', () => {
    expect(parseDailyBarsQuery({ symbol: 'nimb', days: 1 })).toEqual({ symbol: 'NIMB', days: 1 });
    expect(parseDailyBarsQuery({ symbol: 'NIMB', days: 500 })).toEqual({ symbol: 'NIMB', days: 500 });
    for (const days of [undefined, null, '20', 0, -1, 501, 1.5, NaN, Infinity]) {
      expect(() => parseDailyBarsQuery({ symbol: 'NIMB', days })).toThrow(Error);
    }
  });
  test('parses optional chain filters without inventing a default expiry', () => {
    expect(parseOptionChainQuery({ symbol: 'nimb' })).toEqual({ symbol: 'NIMB' });
    expect(parseOptionChainQuery({ symbol: 'NIMB', expiry: '2026-11-06', strikeRange: { min: 100, max: 100 } })).toEqual({
      symbol: 'NIMB', expiry: '2026-11-06', strikeRange: { min: 100, max: 100 },
    });
    for (const filters of [
      { expiry: '2026-02-29' }, { expiry: null }, { strikeRange: null }, { strikeRange: [] },
      { strikeRange: {} }, { strikeRange: { min: 110, max: 100 } },
      { strikeRange: { min: -1, max: 100 } }, { strikeRange: { min: '90', max: 100 } },
      { strikeRange: { min: 90, max: Infinity } }, { strikeRange: { min: NaN, max: 100 } },
    ]) expect(() => parseOptionChainQuery({ symbol: 'NIMB', ...filters })).toThrow(Error);
  });
  test('side accepts only literal put or call and omission adds no default', () => {
    expect(parseOptionChainQuery({ symbol: 'nimb' })).toEqual({ symbol: 'NIMB' });
    for (const side of ['put', 'call'] satisfies ('put' | 'call')[]) {
      expect(parseOptionChainQuery({ symbol: 'nimb', side })).toEqual({ symbol: 'NIMB', side });
    }
    for (const side of [undefined, null, '', 'PUT', 'CALL', 'Put', 'both', ' put', 'put ', 'put\n', 0, true, {}, [], ['put']]) {
      expect(() => parseOptionChainQuery({ symbol: 'NIMB', side })).toThrow('Invalid option side.');
    }
  });
  test('parses contract identity without exposing other fields', () => {
    expect(parseContractQuery({ occ: 'NIMB261106P00100000' })).toEqual({ occ: 'O:NIMB261106P00100000' });
    expect(() => parseContractQuery({ occ: 'O:NIMB260229P00100000' })).toThrow(Error);
  });
  test.each([null, undefined, [], 'NIMB', 3, {}, { symbol: 'A/B', days: 20 }].map(value => ({ value })))('rejects malformed query object $value', ({ value }) => {
    expect(() => parseDailyBarsQuery(value)).toThrow(Error);
    expect(() => parseOptionChainQuery(value)).toThrow(Error);
    expect(() => parseContractQuery(value)).toThrow(Error);
  });
});

describe('provider result envelopes', () => {
  for (const endpoint of endpoints) {
    describe(endpoint.name, () => {
      test('retains provider, fetch time, and cache provenance', () => {
        const result = endpoint.run(endpoint.valid, { ...metadata, source: 'cache' });
        expect(result).toMatchObject({ provider: 'massive', fetchedAt: metadata.fetchedAt, source: 'cache', status: 'ok', issues: [] });
      });
      test('distinguishes an explicit empty response from malformed data', () => {
        expect(endpoint.run(endpoint.empty)).toMatchObject({ status: 'empty', rows: [], asOf: null });
        for (const raw of [null, undefined, 4, 'not JSON', {}, { status: 'OK' }, { results: 'bad' }, { results: {} }]) {
          const result = endpoint.run(raw);
          expect(result.status).toBe('error');
          expect(result.rows).toEqual([]);
          expect(result.issues.length).toBeGreaterThan(0);
        }
      });
      test.each(['NOT_AUTHORIZED', 'NOT_ENTITLED', 'UNAVAILABLE'])('maps %s to unavailable without reflecting provider text', status => {
        const result = endpoint.run({ status, message: 'https://fictional.invalid/?apiKey=DO_NOT_ECHO', error: 'DO_NOT_ECHO' });
        expect(result).toMatchObject({ status: 'unavailable', rows: [], provider: 'massive', source: 'network' });
        expect(result.issues.length).toBeGreaterThan(0);
        expect(JSON.stringify(result)).not.toContain('DO_NOT_ECHO');
        expect(JSON.stringify(result)).not.toContain('fictional.invalid');
      });
      test('malformed status is an error without string coercion', () => {
        for (const status of [['OK'], { toString: 0 }, 1, null, false]) {
          expect(endpoint.run({ status, results: [] })).toMatchObject({ status: 'error', rows: [] });
        }
      });
      test('provider ERROR wins over otherwise valid-looking rows and stays generic', () => {
        const result = endpoint.run({ status: 'ERROR', message: 'DO_NOT_ECHO', results: bars.results });
        expect(result.status).toBe('error');
        expect(result.rows).toEqual([]);
        expect(result.issues.length).toBeGreaterThan(0);
        expect(JSON.stringify(result)).not.toContain('DO_NOT_ECHO');
      });
      test('an explicit asOf overrides inferred timestamps, including explicit null', () => {
        const asOf = '2026-10-29T17:00:00.000Z';
        expect(endpoint.run(endpoint.valid, { ...metadata, asOf }).asOf).toBe(asOf);
        expect(endpoint.run(endpoint.valid, { ...metadata, asOf: null }).asOf).toBeNull();
      });
    });
  }
});

describe('timestamp units', () => {
  test('nanoseconds support integer strings, bigint, and numeric provider timestamps', () => {
    expect(nanosecondsToIso('1793390400123456789')).toBe('2026-10-30T20:00:00.123Z');
    expect(nanosecondsToIso(1793390400123456789n)).toBe('2026-10-30T20:00:00.123Z');
    expect(nanosecondsToIso(1793390460000000000)).toBe('2026-10-30T20:01:00.000Z');
    expect(millisecondsToIso(1793390400123)).toBe('2026-10-30T20:00:00.123Z');
    const boundary = 1793390400000999936n;
    expect(nanosecondsToIso(Number(boundary))).toBe('2026-10-30T20:00:00.000Z');
    expect(nanosecondsToIso(boundary)).toBe(nanosecondsToIso(Number(boundary)));
  });
  test.each([undefined, null, true, {}, [], '', 'not-a-time', 'Infinity', '1793390400000000000\n', NaN, Infinity, -Infinity,
    '9999999999999999999999999999999999999999999999999999999999'].map(value => ({ value })))('invalid timestamp $value returns null instead of throwing', ({ value }) => {
    expect(nanosecondsToIso(value)).toBeNull();
    expect(millisecondsToIso(value)).toBeNull();
  });
  test('out-of-range bigint and fractional nanosecond strings are safe', () => {
    expect(nanosecondsToIso(10n ** 50n)).toBeNull();
    expect(nanosecondsToIso('1793390400123456789.5')).toBeNull();
    expect(millisecondsToIso(Number.MAX_VALUE)).toBeNull();
  });
});

describe('daily bar normalization', () => {
  test('sorts the latest requested NY trading dates and preserves OHLC and zero volume', () => {
    const result = normalizeDailyBars(bars, barsQuery, metadata);
    expect(result.status).toBe('ok');
    expect(result.rows).toEqual([
      { symbol: 'NIMB', date: '2026-10-27', open: 100, high: 103, low: 99, close: 102, volume: 1500,
        startedAt: '2026-10-27T04:00:00.000Z', provisional: false },
      { symbol: 'NIMB', date: '2026-10-28', open: 102, high: 104, low: 100, close: 101, volume: 0,
        startedAt: '2026-10-28T04:00:00.000Z', provisional: false },
      { symbol: 'NIMB', date: '2026-10-29', open: 102, high: 105, low: 101, close: 103, volume: 1900,
        startedAt: '2026-10-29T04:00:00.000Z', provisional: false },
      { symbol: 'NIMB', date: '2026-10-30', open: 103, high: 107, low: 102, close: 106, volume: 2200,
        startedAt: '2026-10-30T04:00:00.000Z', provisional: true },
    ]);
    expect(result.asOf).toBe('2026-10-30T04:00:00.000Z');
    const latest = normalizeDailyBars(bars, { symbol: 'NIMB', days: 2 }, metadata);
    expect(latest.status).toBe('ok');
    expect(latest.rows.map(row => row.date)).toEqual(['2026-10-29', '2026-10-30']);
  });
  test('insufficient bars are partial rather than silently complete', () => {
    const result = normalizeDailyBars(bars, { symbol: 'NIMB', days: 5 }, metadata);
    expect(result.status).toBe('partial');
    expect(result.rows).toHaveLength(4);
    expect(result.issues.length).toBeGreaterThan(0);
  });
  test('dates use New York rather than UTC, including a DST transition', () => {
    const result = normalizeDailyBars({ results: [
      { t: 1793406600000, o: 100, h: 101, l: 99, c: 100 },
      { t: 1793595600000, o: 100, h: 101, l: 99, c: 100 },
    ] }, { symbol: 'NIMB', days: 2 }, { ...metadata, fetchedAt: '2026-11-02T22:00:00.000Z' });
    expect(result.rows.map(row => [row.date, row.provisional])).toEqual([
      ['2026-10-30', false], ['2026-11-02', true],
    ]);
    expect(result.rows.every(row => row.volume === null)).toBe(true);
  });
  test.each([
    { o: 109 }, { c: 108 }, { h: 101 }, { l: 108 }, { o: '103' }, { h: NaN },
    { c: Infinity }, { t: 'not-a-time' }, { t: Number.MAX_VALUE },
  ])('rejects inconsistent or malformed bar %j but retains valid siblings', invalid => {
    const raw = { results: [bars.results[1], { ...bars.results[0], ...invalid }] };
    const result = normalizeDailyBars(raw, { symbol: 'NIMB', days: 1 }, metadata);
    expect(result.status).toBe('partial');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].date).toBe('2026-10-27');
    expect(result.issues.length).toBeGreaterThan(0);
  });
  test('missing required fields reject a row, and all-invalid is an error rather than empty', () => {
    for (const raw of [{ results: [null, {}] }, { results: [without(bars.results[0], 'o')] },
      { results: [without(bars.results[0], 't')] }]) {
      expect(normalizeDailyBars(raw, { symbol: 'NIMB', days: 1 }, metadata)).toMatchObject({ status: 'error', rows: [] });
    }
  });
  test.each([undefined, null, '2200', -1, NaN, Infinity].map(volume => ({ volume })))('missing or invalid volume $volume is null, not a fabricated zero', ({ volume }) => {
    const result = normalizeDailyBars({ results: [{ ...bars.results[0], v: volume }] }, { symbol: 'NIMB', days: 1 }, metadata);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].volume).toBeNull();
  });
  test('rejects a provider response for a different underlying', () => {
    expect(normalizeDailyBars({ ...bars, ticker: 'OTHER' }, barsQuery, metadata)).toMatchObject({ status: 'error', rows: [] });
  });
});

describe('option snapshot normalization', () => {
  test('maps contract identity, fractional IV, Greeks, nanosecond quote time and valid zeros', () => {
    const result = normalizeContract(contract, contractQuery, metadata);
    expect(result.status).toBe('ok');
    expect(result.rows).toEqual([{
      occ: 'O:NIMB261106P00100000', symbol: 'NIMB', expiry: '2026-11-06', side: 'put', strike: 100,
      bid: 0, ask: 0.2, iv: 0.32, greeks: { delta: -0.18, gamma: 0.04, theta: -0.06, vega: 0.11 },
      openInterest: 0, volume: 0, quotedAt: '2026-10-30T20:00:00.123Z',
    }]);
    expect(result.asOf).toBe('2026-10-30T20:00:00.123Z');
  });
  for (const kind of ['optionChain', 'contract'] as const) {
    const normalize = (row: unknown) => kind === 'contract'
      ? normalizeContract({ results: row }, contractQuery, metadata)
      : normalizeOptionChain({ results: [row] }, chainQuery, metadata);

    test(`${kind} nulls a 2046 quote fetched in 2026 without changing prices`, () => {
      const result = normalize({ ...option, last_quote: { ...option.last_quote,
        last_updated: (BigInt(Date.parse('2046-10-30T20:00:00.123Z')) * 1_000_000n).toString() } });
      expect(result).toMatchObject({ status: 'partial', asOf: null,
        issues: ['Option quote time is missing or invalid.'] });
      expect(result.rows).toEqual(normalizeContract(contract, contractQuery, metadata).rows.map(row => ({ ...row, quotedAt: null })));
      expect(decodeDataResult(kind, result)).toEqual(result);
    });

    test(`${kind} accepts exactly five minutes of future tolerance but not one millisecond more`, () => {
      const boundary = Date.parse(metadata.fetchedAt) + 5 * 60_000;
      for (const offset of [0, 1]) {
        const quotedAt = new Date(boundary + offset).toISOString();
        const result = normalize({ ...option, last_quote: { ...option.last_quote,
          last_updated: (BigInt(boundary + offset) * 1_000_000n).toString() } });
        expect(result).toMatchObject({ status: offset === 0 ? 'ok' : 'partial',
          asOf: offset === 0 ? quotedAt : null });
        expect(result.rows[0]).toMatchObject({ bid: option.last_quote.bid, ask: option.last_quote.ask,
          quotedAt: offset === 0 ? quotedAt : null });
        expect(decodeDataResult(kind, result)).toEqual(result);
      }
    });

    test(`${kind} retains historical quote times exactly without a freshness cutoff`, () => {
      for (const quotedAt of ['2020-01-02T20:00:00.123Z', '2026-09-01T20:00:00.123Z']) {
        const result = normalize({ ...option, last_quote: { ...option.last_quote,
          last_updated: (BigInt(Date.parse(quotedAt)) * 1_000_000n).toString() } });
        expect(result).toMatchObject({ status: 'ok', issues: [], asOf: quotedAt });
        expect(result.rows).toEqual(normalizeContract(contract, contractQuery, metadata).rows.map(row => ({ ...row, quotedAt })));
        expect(decodeDataResult(kind, result)).toEqual(result);
      }
    });

    for (const source of ['network', 'cache'] as const) {
      for (const status of ['ok', 'partial'] as const) {
        test(`${kind} DTO rejects future quote times from ${source} even when ${status}`, () => {
          const valid = normalizeContract(contract, contractQuery, metadata);
          for (const quotedAt of ['2046-10-30T20:00:00.123Z',
            new Date(Date.parse(metadata.fetchedAt) + 5 * 60_000 + 1).toISOString()]) {
            const result = { ...valid, source, status,
              issues: status === 'partial' ? ['Provider response is incomplete.'] : [],
              rows: valid.rows.map(row => ({ ...row, quotedAt })) };
            expect(() => decodeDataResult(kind, result)).toThrow('Invalid market data result.');
          }
        });
      }
    }
  }
  test('chain asOf is newest option quote, not underlying or fetch time', () => {
    const result = normalizeOptionChain(chain, chainQuery, metadata);
    expect(result.status).toBe('ok');
    expect(result.rows).toHaveLength(3);
    expect(result.asOf).toBe('2026-10-30T20:01:00.000Z');
    expect(result.rows.find(row => row.side === 'call')).toMatchObject({ strike: 105, iv: 0.31 });
  });
  test('expiry and strike bounds are inclusive, and matching nothing is valid empty', () => {
    const query = parseOptionChainQuery({ symbol: 'NIMB', expiry: '2026-11-06', strikeRange: { min: 100, max: 105 } });
    const result = normalizeOptionChain(chain, query, metadata);
    expect(result.status).toBe('ok');
    expect(result.rows.map(row => row.strike).sort((a, b) => a - b)).toEqual([100, 105]);
    const none = normalizeOptionChain(chain, { symbol: 'NIMB', expiry: '2027-01-15' }, metadata);
    expect(none).toMatchObject({ status: 'empty', rows: [], asOf: null });
  });
  test('side filters complete CALL-first rows with the same expiry and inclusive strike range', () => {
    const query = { symbol: 'NIMB', expiry: '2026-11-06', strikeRange: { min: 100, max: 111 } };
    const all = normalizeOptionChain(callsBeforePuts, query, metadata);
    expect(all.status).toBe('ok');
    expect(all.rows).toHaveLength(24);
    expect(all.rows.slice(0, 10).every(row => row.side === 'call')).toBe(true);
    for (const side of ['put', 'call'] satisfies ('put' | 'call')[]) {
      const result = normalizeOptionChain(callsBeforePuts, { ...query, side }, metadata);
      expect(result).toMatchObject({ status: 'ok', issues: [], asOf: '2026-10-30T20:00:00.123Z' });
      expect(result.rows).toEqual(all.rows.filter(row => row.side === side));
      expect(result.rows).toHaveLength(12);
      expect(normalizeOptionChain(callsBeforePuts, { ...query, side, strikeRange: { min: 100, max: 100 } }, metadata).rows)
        .toEqual(result.rows.slice(0, 1));
    }
    expect(normalizeOptionChain({ status: 'OK', results: callsBeforePuts.results.slice(0, 12) },
      { ...query, side: 'put' }, metadata)).toMatchObject({ status: 'empty', rows: [], asOf: null });
  });
  test('filtered-out valid rows plus a malformed sibling can be partial with zero returned rows', () => {
    const result = normalizeOptionChain({ results: [option, {}] }, { symbol: 'NIMB', expiry: '2027-01-15' }, metadata);
    expect(result.status).toBe('partial');
    expect(result.rows).toEqual([]);
    expect(result.issues.length).toBeGreaterThan(0);
  });
  test('valid identity with no optional data stays partial with null fields', () => {
    const result = normalizeContract({ results: { details: option.details } }, contractQuery, metadata);
    expect(result.status).toBe('partial');
    expect(result.rows).toEqual([{
      occ: 'O:NIMB261106P00100000', symbol: 'NIMB', expiry: '2026-11-06', side: 'put', strike: 100,
      bid: null, ask: null, iv: null, greeks: { delta: null, gamma: null, theta: null, vega: null },
      openInterest: null, volume: null, quotedAt: null,
    }]);
    expect(result.asOf).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
  });
  test.each([
    { field: 'bid', row: { ...option, last_quote: without(option.last_quote, 'bid') } },
    { field: 'ask', row: { ...option, last_quote: without(option.last_quote, 'ask') } },
    { field: 'iv', row: without(option, 'implied_volatility') },
    { field: 'openInterest', row: without(option, 'open_interest') },
  ])('missing desired $field is partial and null', ({ field, row }) => {
    const result = normalizeContract({ results: row }, contractQuery, metadata);
    expect(result.status).toBe('partial');
    expect(result.rows[0]).toHaveProperty(field, null);
    expect(result.issues.length).toBeGreaterThan(0);
  });
  test.each(['delta', 'gamma', 'theta', 'vega'])('missing Greek %s is partial and null', field => {
    const result = normalizeContract({ results: { ...option, greeks: without(option.greeks, field) } }, contractQuery, metadata);
    expect(result.status).toBe('partial');
    expect(result.rows[0].greeks).toHaveProperty(field, null);
  });
  test('zero Greeks are real observations, not missing values', () => {
    const greeks = { delta: 0, gamma: 0, theta: 0, vega: 0 };
    const result = normalizeContract({ results: { ...option, greeks } }, contractQuery, metadata);
    expect(result.status).toBe('ok');
    expect(result.rows[0].greeks).toEqual(greeks);
  });
  test('crossed quotes null both sides without losing valid identity or Greeks', () => {
    const result = normalizeContract({ results: { ...option, last_quote: { ...option.last_quote, bid: 4, ask: 3 } } }, contractQuery, metadata);
    expect(result.status).toBe('partial');
    expect(result.rows[0]).toMatchObject({ bid: null, ask: null, iv: 0.32, occ: contractQuery.occ });
  });
  test.each([null, '0.32', -0.1, NaN, Infinity])('invalid IV %j becomes null and partial without percent conversion', iv => {
    const result = normalizeContract({ results: { ...option, implied_volatility: iv } }, contractQuery, metadata);
    expect(result.status).toBe('partial');
    expect(result.rows[0].iv).toBeNull();
  });
  test('invalid optional numbers and timestamps are null rather than coerced', () => {
    const result = normalizeContract({ results: { ...option,
      last_quote: { bid: -1, ask: '0.2', last_updated: 'invalid' },
      open_interest: '0', day: { volume: -1 }, greeks: { delta: '0', gamma: Infinity, theta: NaN, vega: null },
    } }, contractQuery, metadata);
    expect(result.status).toBe('partial');
    expect(result.rows[0]).toMatchObject({ bid: null, ask: null, openInterest: null, volume: null,
      quotedAt: null, greeks: { delta: null, gamma: null, theta: null, vega: null } });
    expect(result.asOf).toBeNull();
  });
  test.each([
    { ...option, underlying_asset: { ticker: 'OTHER' } },
    { ...option, details: { ...option.details, ticker: 'O:OTHER261106P00100000' } },
    { ...option, details: { ...option.details, expiration_date: '2026-11-13' } },
    { ...option, details: { ...option.details, strike_price: 101 } },
    { ...option, details: { ...option.details, contract_type: 'call' } },
    { ...option, details: { ...option.details, expiration_date: '2026-02-29', ticker: 'O:NIMB260229P00100000' } },
    { ...option, details: {} }, null,
  ])('rejects inconsistent identity %j and keeps a valid chain sibling', invalid => {
    const result = normalizeOptionChain({ results: [chain.results[1], invalid] }, chainQuery, metadata);
    expect(result.status).toBe('partial');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].occ).toBe('O:NIMB261106C00105000');
    expect(result.issues.length).toBeGreaterThan(0);
    expect(normalizeOptionChain({ results: [invalid] }, chainQuery, metadata)).toMatchObject({ status: 'error', rows: [] });
  });
  test('single-contract requests reject a valid but different contract', () => {
    expect(normalizeContract({ results: chain.results[1] }, contractQuery, metadata)).toMatchObject({ status: 'error', rows: [] });
  });
  test('single-contract null is empty, but an object without identity or an array is malformed', () => {
    expect(normalizeContract({ results: null }, contractQuery, metadata)).toMatchObject({ status: 'empty', rows: [] });
    for (const results of [{}, [], [option]]) {
      expect(normalizeContract({ results }, contractQuery, metadata)).toMatchObject({ status: 'error', rows: [] });
    }
  });
});

describe('market holiday normalization', () => {
  test('preserves full closures and early-close times without inventing asOf', () => {
    const result = normalizeMarketHolidays(holidays, metadata);
    expect(result.status).toBe('ok');
    expect(result.rows).toEqual([
      { date: '2026-11-26', exchange: 'NYSE', status: 'closed', open: null, close: null },
      { date: '2026-11-27', exchange: 'NASDAQ', status: 'early-close',
        open: '2026-11-27T14:30:00.000Z', close: '2026-11-27T18:00:00.000Z' },
    ]);
    expect(result.asOf).toBeNull();
  });
  test('closed rows without provider times still expose null times', () => {
    const result = normalizeMarketHolidays([{ date: '2026-11-26', exchange: 'NYSE', status: 'closed' }], metadata);
    expect(result.rows[0]).toMatchObject({ status: 'closed', open: null, close: null });
  });
  test('bad calendar rows do not erase valid holiday siblings', () => {
    const result = normalizeMarketHolidays([holidays[0], { ...holidays[1], date: '2026-02-29' }, null], metadata);
    expect(result.status).toBe('partial');
    expect(result.rows).toHaveLength(1);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(normalizeMarketHolidays([{}], metadata)).toMatchObject({ status: 'error', rows: [] });
  });
  test('validates each provided holiday time against its session date independently', () => {
    for (const status of ['closed', 'early-close']) {
      for (const time of [{ open: '2026-11-27T14:30:00Z' }, { close: '2026-11-27T18:00:00Z' }]) {
        const result = normalizeMarketHolidays([{ date: '2026-11-26', exchange: 'NYSE', status, ...time }], metadata);
        expect(result).toMatchObject({ status: 'error', rows: [] });
      }
    }
  });
  test('does not accept a results envelope instead of the documented raw array', () => {
    expect(normalizeMarketHolidays({ results: holidays }, metadata)).toMatchObject({ status: 'error', rows: [] });
  });
});

describe('Treasury normalization', () => {
  test('chooses latest valid date regardless of provider order and converts percent to annual decimal', () => {
    const result = normalizeTreasuryRate(treasury, metadata);
    expect(result.status).toBe('ok');
    expect(result.rows).toEqual([{ date: '2026-10-30', annualRate: 0.0425 }]);
    expect(result.asOf).toBe('2026-10-30');
  });
  test('zero rate is valid and not missing', () => {
    const result = normalizeTreasuryRate({ results: [{ date: '2026-10-30', yield_1_month: 0 }] }, metadata);
    expect(result.status).toBe('ok');
    expect(result.rows).toEqual([{ date: '2026-10-30', annualRate: 0 }]);
  });
  test.each([
    { date: '2026-10-31' }, { date: '2026-10-31', yield_1_month: null },
    { date: '2026-10-31', yield_1_month: '4.25' }, { date: '2026-10-31', yield_1_month: Infinity },
    { date: '2026-02-29', yield_1_month: 4.5 }, {}, null,
  ])('skips invalid observation %j and retains latest valid rate as partial', invalid => {
    const result = normalizeTreasuryRate({ results: [...treasury.results, invalid] }, metadata);
    expect(result.status).toBe('partial');
    expect(result.rows).toEqual([{ date: '2026-10-30', annualRate: 0.0425 }]);
    expect(result.asOf).toBe('2026-10-30');
    expect(result.issues.length).toBeGreaterThan(0);
    expect(normalizeTreasuryRate({ results: [invalid] }, metadata)).toMatchObject({ status: 'error', rows: [] });
  });
});
