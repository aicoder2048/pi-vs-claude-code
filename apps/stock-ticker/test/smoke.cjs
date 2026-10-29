'use strict';

const { _electron: electron } = require('@playwright/test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');

(async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'stock-desk-smoke-'));
  let application;
  try {
    application = await electron.launch({ args: [path.resolve(__dirname, '..'), `--user-data-dir=${userData}`] });
    const page = await application.firstWindow();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.waitForSelector('#query-button');
    assert.equal(await page.title(), 'Stock Desk · 股票行情');
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.evaluate(() => typeof window.stockDesk.fetchQuotes), 'function');
    assert.match(await page.locator('#tickers').inputValue(), /NVDA/);

    // Inject deterministic upstream responses in the main process, not a shipped mock mode.
    // Keep the production IPC validation and in-flight lock in place.
    await application.evaluate(() => {
      globalThis.fetch = async (url) => {
        const symbol = decodeURIComponent(url.pathname.split('/').at(-1));
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (symbol === 'BAD') return { ok: false, status: 404 };
        const regular = { start: Date.parse('2026-10-28T13:30:00Z') / 1000, end: Date.parse('2026-10-28T20:00:00Z') / 1000 };
        const post = { start: regular.end, end: regular.end + 14400 };
        const data = url.searchParams.get('interval') === '1d'
          ? { timestamp: [regular.start - 86400, regular.start], indicators: { quote: [{ close: [100, 110] }] } }
          : {
            meta: { symbol, longName: '<img src=x onerror=alert(1)>', currency: 'USD', exchangeTimezoneName: 'America/New_York', regularMarketPrice: 110, regularMarketTime: regular.end + 1, tradingPeriods: { regular: [[regular]], post: [[post]] } },
            timestamp: [post.start + 300], indicators: { quote: [{ close: [99] }] },
          };
        return { ok: true, json: async () => ({ chart: { result: [data] } }) };
      };
      Date.now = () => Date.parse('2026-10-29T04:00:00Z');
    });

    // Two requests must not let a duplicate clear the main-process in-flight lock.
    const concurrent = await page.evaluate(async () => {
      const first = window.stockDesk.fetchQuotes('NVDA');
      const second = await window.stockDesk.fetchQuotes('META');
      const third = await window.stockDesk.fetchQuotes('AAPL');
      return [await first, second, third];
    });
    assert.equal(concurrent[0].ok, true);
    assert.equal(concurrent[1].ok, false);
    assert.equal(concurrent[2].ok, false);

    await page.locator('#tickers').fill('nvda, BAD');
    await page.locator('#query-button').click();
    await page.waitForFunction(() => document.getElementById('results-panel').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#quote-body tr').count(), 2);
    assert.match(await page.locator('#quote-body tr').first().innerText(), /NVDA/);
    assert.match(await page.locator('#quote-body tr').first().innerText(), /\+10\.00%/);
    assert.match(await page.locator('#quote-body tr').first().innerText(), /-10\.00%/);
    assert.match(await page.locator('#quote-body tr').last().innerText(), /未找到/);
    assert.equal(await page.locator('#quote-body img').count(), 0);
    assert.equal(await page.locator('#refresh-button').isEnabled(), true);
    await page.locator('#tickers').fill('../bad');
    await page.locator('#quote-form').evaluate((form) => form.requestSubmit());
    await page.locator('#error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#error').innerText(), /无效/);
    assert.equal(await page.locator('#quote-body tr').count(), 2);
    await page.locator('#refresh-button').click();
    await page.waitForFunction(() => document.getElementById('results-panel').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#error').isHidden(), true);
    await page.locator('#tech-preset').click();
    assert.match(await page.locator('#tickers').inputValue(), /GOOGL, NVDA, META/);
    assert.deepEqual(pageErrors, []);
    const screenshot = path.join(os.tmpdir(), 'stock-desk-smoke.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log(`Electron UI smoke test passed. Screenshot: ${screenshot}`);
  } finally {
    if (application) await application.close();
    await fs.rm(userData, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
