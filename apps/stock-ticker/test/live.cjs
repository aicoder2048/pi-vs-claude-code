'use strict';

const assert = require('node:assert/strict');
const { getQuotes } = require('../src/quotes.cjs');

(async () => {
  const result = await getQuotes(process.argv.slice(2).join(',') || 'NVDA,META,GOOGL');
  console.table(result.rows.map((row) => ({
    ticker: row.symbol, date: row.tradeDate, regular: row.regularPrice,
    dayPercent: row.dayChangePercent?.toFixed(2), afterHours: row.afterHours?.price,
    afterPercent: row.afterHours?.changePercent?.toFixed(2), error: row.error,
  })));
  assert.ok(result.rows.every((row) => row.ok), 'Some live quotes failed; provider may be unavailable or rate limited.');
  assert.ok(result.rows.every((row) => row.previousClose !== null), 'Daily data is missing.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
