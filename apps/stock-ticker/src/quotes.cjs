'use strict';

const MAX_TICKERS = 20;
const SYMBOL_PATTERN = /^[A-Z0-9^][A-Z0-9.^=\-]{0,19}$/;

function parseTickers(input) {
  if (typeof input !== 'string' || input.length > 1000) {
    throw new Error('请输入 ticker，最多 1000 个字符。');
  }
  const symbols = [...new Set(input.toUpperCase().split(/[,，\s]+/).filter(Boolean))];
  if (!symbols.length) throw new Error('请输入至少一个 ticker，例如 NVDA, META。');
  if (symbols.length > MAX_TICKERS) throw new Error(`一次最多查询 ${MAX_TICKERS} 个 ticker。`);
  const invalid = symbols.find((symbol) => !SYMBOL_PATTERN.test(symbol));
  if (invalid) throw new Error(`无效的 ticker：${invalid}。只支持字母、数字及 . - ^ =。`);
  return symbols;
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const price = (value) => finite(value) && value > 0 ? value : null;
const iso = (seconds) => finite(seconds) ? new Date(seconds * 1000).toISOString() : null;

function dateKey(seconds, timeZone) {
  if (!finite(seconds)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(seconds * 1000));
  const get = (name) => parts.find((part) => part.type === name)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function periods(meta, type) {
  const historical = meta.tradingPeriods?.[type];
  const result = Array.isArray(historical) ? historical.flat(Infinity) : [];
  return [...result, meta.currentTradingPeriod?.[type]].filter((period) =>
    period && finite(period.start) && finite(period.end) && period.end > period.start);
}

function changeFrom(value, base) {
  if (!finite(value) || !finite(base) || base <= 0) return { amount: null, percent: null };
  return { amount: value - base, percent: (value / base - 1) * 100 };
}

function normalizeQuote(symbol, intraday, daily, now = Date.now()) {
  const meta = intraday?.meta;
  if (!meta || price(meta.regularMarketPrice) === null || !finite(meta.regularMarketTime)) {
    throw new Error('数据源没有返回有效的常规交易价格。');
  }
  const timeZone = meta.exchangeTimezoneName || 'America/New_York';
  const tradeDate = dateKey(meta.regularMarketTime, timeZone);
  const regular = periods(meta, 'regular').find((period) => dateKey(period.start, timeZone) === tradeDate);
  const post = periods(meta, 'post').find((period) => dateKey(period.start, timeZone) === tradeDate);
  const nowSeconds = now / 1000;
  const session = regular
    ? (nowSeconds < regular.end ? 'regular' : 'closed')
    : 'unknown';

  // A multi-day chart's chartPreviousClose is the start-of-range baseline, NOT yesterday's close.
  // Use the daily bar before this regular quote's trading date instead.
  const dailyCloses = daily?.indicators?.quote?.[0]?.close || [];
  const previousBars = (daily?.timestamp || []).map((time, index) => ({
    time, date: dateKey(time, timeZone), value: price(dailyCloses[index]),
  })).filter((bar) => bar.date < tradeDate && bar.value !== null).sort((a, b) => b.time - a.time);
  const previousClose = previousBars[0]?.value ?? null;
  const regularPrice = meta.regularMarketPrice;
  const dayChange = changeFrom(regularPrice, previousClose);
  const warnings = [];
  if (previousClose === null) warnings.push('缺少上一交易日收盘数据，无法计算当日涨跌。');
  if (!regular) warnings.push('无法确认交易时段；常规价格不标记为已收盘。');

  let afterHours = null;
  // Only use the SAME trading day's post session. Never substitute pre-market/overnight prices.
  if (session === 'closed' && post) {
    let latest = null;
    const closes = intraday.indicators?.quote?.[0]?.close || [];
    for (const [index, time] of (intraday.timestamp || []).entries()) {
      const value = price(closes[index]);
      if (finite(time) && time >= post.start && time < post.end && time <= nowSeconds && value !== null && (!latest || time > latest.time)) {
        latest = { time, value, kind: 'bar' };
      }
    }
    const postTime = meta.postMarketTime;
    if (price(meta.postMarketPrice) !== null && finite(postTime) && postTime >= post.start && postTime < post.end && postTime <= nowSeconds && (!latest || postTime >= latest.time)) {
      latest = { time: postTime, value: meta.postMarketPrice, kind: 'quote' };
    }
    if (latest) {
      const change = changeFrom(latest.value, regularPrice);
      afterHours = {
        price: latest.value, change: change.amount, changePercent: change.percent,
        time: iso(latest.time), kind: latest.kind,
      };
    }
  }

  return {
    symbol: meta.symbol || symbol,
    name: meta.longName || meta.shortName || symbol,
    currency: meta.currency || 'USD',
    exchange: meta.fullExchangeName || meta.exchangeName || '—',
    timeZone, tradeDate, session,
    regularPrice, regularTime: iso(meta.regularMarketTime), previousClose,
    dayChange: dayChange.amount, dayChangePercent: dayChange.percent,
    afterHours, warnings,
  };
}

async function fetchChart(symbol, interval, range, fetchImpl) {
  let lastError;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const url = new URL(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}`);
      url.search = new URLSearchParams({ interval, range, includePrePost: 'true' }).toString();
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 StockTicker/1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) {
        if (response.status === 404) throw new Error(`未找到 ${symbol}，请检查 ticker。`);
        if (response.status === 429) throw new Error('行情源请求过于频繁，请稍后重试。');
        throw new Error(`行情服务返回 HTTP ${response.status}。`);
      }
      const payload = await response.json();
      if (payload.chart?.error) throw new Error(payload.chart.error.description || '行情服务暂不可用。');
      const result = payload.chart?.result?.[0];
      if (!result) throw new Error(`未找到 ${symbol} 的行情。`);
      return result;
    } catch (error) {
      lastError = error;
      if (/未找到/.test(error.message)) break;
    }
  }
  if (lastError?.name === 'TimeoutError' || lastError?.name === 'AbortError') {
    throw new Error('请求超时，请检查网络后重试。');
  }
  throw new Error(lastError?.message || '无法连接行情源，请检查网络。');
}

async function getQuotes(input, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const symbols = parseTickers(input);
  const rows = new Array(symbols.length);
  let next = 0;
  async function worker() {
    while (next < symbols.length) {
      const index = next++;
      const symbol = symbols[index];
      try {
        const [intraday, daily] = await Promise.allSettled([
          fetchChart(symbol, '5m', '5d', fetchImpl),
          fetchChart(symbol, '1d', '1mo', fetchImpl),
        ]);
        if (intraday.status === 'rejected') throw intraday.reason;
        rows[index] = {
          ok: true,
          ...normalizeQuote(symbol, intraday.value, daily.status === 'fulfilled' ? daily.value : null, now()),
        };
      } catch (error) {
        rows[index] = { ok: false, symbol, error: error.message || '查询失败。' };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, symbols.length) }, worker));
  return { rows, fetchedAt: new Date(now()).toISOString(), source: 'Yahoo Finance' };
}

module.exports = { parseTickers, normalizeQuote, getQuotes, dateKey, changeFrom };
