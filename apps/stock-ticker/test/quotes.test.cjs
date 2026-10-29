'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTickers, normalizeQuote, getQuotes, dateKey } = require('../src/quotes.cjs');

const ts = (value) => Date.parse(value) / 1000;
const regular = { start: ts('2026-10-28T13:30:00Z'), end: ts('2026-10-28T20:00:00Z') };
const post = { start: regular.end, end: ts('2026-10-29T00:00:00Z') };
const now = Date.parse('2026-10-29T04:00:00Z');

function fixture() {
  return {
    intraday: {
      meta: {
        symbol: 'NVDA', longName: 'NVIDIA Corporation', currency: 'USD',
        exchangeTimezoneName: 'America/New_York', regularMarketPrice: 110,
        regularMarketTime: regular.end + 1,
        chartPreviousClose: 70,
        // currentTradingPeriod can already refer to TOMORROW before the next open.
        currentTradingPeriod: {
          regular: { start: ts('2026-10-29T13:30:00Z'), end: ts('2026-10-29T20:00:00Z') },
          post: { start: ts('2026-10-29T20:00:00Z'), end: ts('2026-10-30T00:00:00Z') },
        },
        tradingPeriods: { regular: [[regular]], post: [[post]] },
      },
      timestamp: [ts('2026-10-27T23:55:00Z'), regular.start, post.start, post.end - 300, post.end - 1, post.end, post.end + 14400],
      indicators: { quote: [{ close: [130, 108, 105, 99, null, 95, 80] }] },
    },
    daily: {
      timestamp: [ts('2026-10-26T13:30:00Z'), ts('2026-10-27T13:30:00Z'), regular.start],
      indicators: { quote: [{ close: [98, 100, 110] }] },
    },
  };
}

test('ticker parsing: uppercase, Chinese commas, whitespace, deduplication, supported suffixes', () => {
  assert.deepEqual(parseTickers(' nvda, Meta，nvda \n BRK-B 0700.HK ^GSPC BTC-USD ES=F'),
    ['NVDA', 'META', 'BRK-B', '0700.HK', '^GSPC', 'BTC-USD', 'ES=F']);
});

test('reject empty, malformed, oversized and non-string input', () => {
  for (const input of ['', ' , ， ', null, {}, 'A'.repeat(1001), 'NVDA,<script>', '../auth', 'AAPL?x=1', Array.from({ length: 21 }, (_, i) => `A${i}`).join(',')]) {
    assert.throws(() => parseTickers(input));
  }
});

test('close, daily change and same-day after-hours change use separate bases', () => {
  const { intraday, daily } = fixture();
  const quote = normalizeQuote('NVDA', intraday, daily, now);
  assert.equal(quote.tradeDate, '2026-10-28');
  assert.equal(quote.session, 'closed');
  assert.equal(quote.regularPrice, 110);
  assert.equal(quote.previousClose, 100);
  assert.equal(quote.dayChange, 10);
  assert.ok(Math.abs(quote.dayChangePercent - 10) < 1e-10);
  assert.equal(quote.afterHours.price, 99);
  assert.equal(quote.afterHours.change, -11);
  assert.ok(Math.abs(quote.afterHours.changePercent + 10) < 1e-10);
  assert.equal(quote.afterHours.time, '2026-10-28T23:55:00.000Z');
  assert.equal(quote.afterHours.kind, 'bar');
});

test('during market hours do not show a final close or future/prior-day after-hours prices', () => {
  const { intraday, daily } = fixture();
  intraday.meta.regularMarketTime = regular.start + 3600;
  const quote = normalizeQuote('NVDA', intraday, daily, (regular.start + 3601) * 1000);
  assert.equal(quote.session, 'regular');
  assert.equal(quote.afterHours, null);
});

test('empty/missing after-hours stays null, not zero or pre-market', () => {
  const { intraday, daily } = fixture();
  intraday.timestamp = [post.start - 300, post.end + 14400];
  intraday.indicators.quote[0].close = [110, 95];
  assert.equal(normalizeQuote('NVDA', intraday, daily, now).afterHours, null);
});

test('missing previous-day data never uses multi-day chartPreviousClose', () => {
  const { intraday } = fixture();
  const quote = normalizeQuote('NVDA', intraday, null, now);
  assert.equal(quote.previousClose, null);
  assert.equal(quote.dayChangePercent, null);
  assert.equal(quote.warnings.length, 1);
  assert.equal(quote.afterHours.price, 99);
});

test('prefer a newer explicit post-market quote, but reject quotes outside its session', () => {
  const { intraday, daily } = fixture();
  intraday.meta.postMarketTime = post.end - 60;
  intraday.meta.postMarketPrice = 101;
  assert.equal(normalizeQuote('NVDA', intraday, daily, now).afterHours.price, 101);
  assert.equal(normalizeQuote('NVDA', intraday, daily, now).afterHours.kind, 'quote');
  intraday.meta.postMarketTime = post.end + 100;
  assert.equal(normalizeQuote('NVDA', intraday, daily, now).afterHours.price, 99);
});

test('missing session metadata is explicitly unknown', () => {
  const { intraday, daily } = fixture();
  delete intraday.meta.tradingPeriods;
  delete intraday.meta.currentTradingPeriod;
  const quote = normalizeQuote('NVDA', intraday, daily, now);
  assert.equal(quote.session, 'unknown');
  assert.equal(quote.afterHours, null);
  assert.ok(quote.warnings.length > 0);
});

test('early close is taken from exchange metadata, not a hard-coded 16:00 rule', () => {
  const { intraday, daily } = fixture();
  const earlyEnd = ts('2026-10-28T17:00:00Z');
  intraday.meta.tradingPeriods.regular = [[{ start: regular.start, end: earlyEnd }]];
  intraday.meta.tradingPeriods.post = [[{ start: earlyEnd, end: post.end }]];
  intraday.meta.regularMarketTime = earlyEnd;
  const quote = normalizeQuote('NVDA', intraday, daily, ts('2026-10-28T18:00:00Z') * 1000);
  assert.equal(quote.session, 'closed');
});

test('dates use exchange timezone, including daylight saving changes', () => {
  assert.equal(dateKey(ts('2026-10-29T01:00:00Z'), 'America/New_York'), '2026-10-28');
  assert.equal(dateKey(ts('2026-11-02T04:30:00Z'), 'America/New_York'), '2026-11-01');
});

test('invalid regular quote fails clearly', () => {
  const { intraday, daily } = fixture();
  for (const value of [null, 0, NaN, Infinity, '110']) {
    intraday.meta.regularMarketPrice = value;
    assert.throws(() => normalizeQuote('NVDA', intraday, daily, now));
  }
});

test('batch preserves input order, isolates bad ticker and fetches only fixed provider hosts', async () => {
  const { intraday, daily } = fixture();
  let active = 0;
  let maxActive = 0;
  const fetchImpl = async (url) => {
    assert.ok(['query1.finance.yahoo.com', 'query2.finance.yahoo.com'].includes(url.hostname));
    active++;
    maxActive = Math.max(active, maxActive);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    const symbol = decodeURIComponent(url.pathname.split('/').at(-1));
    if (symbol === 'BAD') return { ok: false, status: 404 };
    const source = url.searchParams.get('interval') === '1d' ? daily : { ...intraday, meta: { ...intraday.meta, symbol } };
    return { ok: true, json: async () => ({ chart: { result: [source] } }) };
  };
  const result = await getQuotes('NVDA,BAD,META,AAPL,MSFT', { fetchImpl, now: () => now });
  assert.deepEqual(result.rows.map((row) => row.symbol), ['NVDA', 'BAD', 'META', 'AAPL', 'MSFT']);
  assert.deepEqual(result.rows.map((row) => row.ok), [true, false, true, true, true]);
  assert.match(result.rows[1].error, /未找到/);
  assert.ok(maxActive <= 6);
});

test('fallback host recovers a provider failure; missing daily data is a warning', async () => {
  const { intraday } = fixture();
  const result = await getQuotes('NVDA', {
    now: () => now,
    fetchImpl: async (url) => {
      if (url.hostname.startsWith('query1') || url.searchParams.get('interval') === '1d') return { ok: false, status: 429 };
      return { ok: true, json: async () => ({ chart: { result: [intraday] } }) };
    },
  });
  assert.equal(result.rows[0].ok, true);
  assert.equal(result.rows[0].dayChangePercent, null);
  assert.ok(result.rows[0].warnings.length > 0);
});

test('network and malformed payload failures are per-row errors', async () => {
  for (const fetchImpl of [async () => { throw new Error('offline'); }, async () => ({ ok: true, json: async () => ({}) })]) {
    const result = await getQuotes('NVDA', { fetchImpl, now: () => now });
    assert.equal(result.rows[0].ok, false);
    assert.ok(result.rows[0].error);
  }
});
