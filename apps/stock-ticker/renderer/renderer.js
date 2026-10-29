'use strict';

const DEFAULT_TICKERS = 'GOOGL, NVDA, META, MSFT, AAPL, AMZN, TSLA';
const $ = (id) => document.getElementById(id);
const input = $('tickers');
let busy = false;
let lastInput = '';
let lastFetchedAt = null;

try { input.value = localStorage.getItem('stock-desk:tickers') || DEFAULT_TICKERS; }
catch { input.value = DEFAULT_TICKERS; }

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function money(value, currency) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  } catch { return `${value.toFixed(2)} ${currency}`; }
}

function signed(value, suffix = '') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${Object.is(value, -0) ? '0.00' : value.toFixed(2)}${suffix}`;
}

function tone(value) { return value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral'; }

function time(value, timeZone) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value));
}

function renderRows(rows) {
  const fragment = document.createDocumentFragment();
  for (const quote of rows) {
    const tr = node('tr');
    const identity = node('td');
    identity.append(node('strong', 'ticker', quote.symbol));
    if (!quote.ok) {
      identity.append(node('small', 'subline', '查询失败'));
      const error = node('td', 'row-error', quote.error);
      error.colSpan = 5;
      tr.append(identity, error);
      fragment.append(tr);
      continue;
    }
    identity.append(node('span', 'company-name', quote.name), node('small', 'subline', `${quote.tradeDate} · ${quote.currency}`));
    const regular = node('td', 'numeric');
    regular.append(node('strong', 'price', money(quote.regularPrice, quote.currency)), node('small', 'subline', quote.session === 'closed' ? '常规收盘' : quote.session === 'regular' ? '盘中最新 · 非收盘价' : '常规最新 · 时段待确认'));
    const daily = node('td', `numeric ${tone(quote.dayChange)}`);
    daily.append(node('strong', 'price', signed(quote.dayChangePercent, '%')), node('small', 'subline', `${signed(quote.dayChange)} ${quote.currency}`));
    const afterPrice = node('td', 'numeric');
    afterPrice.append(node('strong', 'price', money(quote.afterHours?.price, quote.currency)), node('small', 'subline', quote.afterHours ? (quote.afterHours.kind === 'bar' ? '5 分钟区间收盘价' : '盘后报价') : '同日暂无盘后报价'));
    const afterChange = node('td', `numeric ${tone(quote.afterHours?.change)}`);
    afterChange.append(node('strong', 'price', signed(quote.afterHours?.changePercent, '%')), node('small', 'subline', quote.afterHours ? `${signed(quote.afterHours.change)} ${quote.currency}` : '—'));
    const status = node('td', 'quote-status');
    status.append(node('span', `session ${quote.session}`, quote.session === 'closed' ? '已收盘' : quote.session === 'regular' ? '常规交易中' : '时段待确认'));
    status.append(node('small', 'subline', `常规 ${time(quote.regularTime, quote.timeZone)}`));
    if (quote.afterHours) status.append(node('small', 'subline', `盘后 ${time(quote.afterHours.time, quote.timeZone)}`));
    status.append(node('small', 'subline timezone', quote.timeZone));
    if (quote.warnings.length) status.append(node('small', 'quote-warning', quote.warnings.join(' ')));
    tr.append(identity, regular, daily, afterPrice, afterChange, status);
    fragment.append(tr);
  }
  $('quote-body').replaceChildren(fragment);
}

function setBusy(value) {
  busy = value;
  $('query-button').disabled = value;
  $('refresh-button').disabled = value || !lastInput;
  $('query-button').textContent = value ? '查询中…' : '查询行情 ↗';
  $('results-panel').setAttribute('aria-busy', String(value));
}

async function query(value) {
  if (busy) return;
  $('error').hidden = true;
  setBusy(true);
  $('status').textContent = lastFetchedAt
    ? '正在获取最新行情，下方仍为上次查询结果…'
    : '正在获取行情，请稍候…';
  try {
    const result = await window.stockDesk.fetchQuotes(value);
    if (!result.ok) throw new Error(result.error);
    renderRows(result.rows);
    lastInput = value;
    lastFetchedAt = result.fetchedAt;
    const success = result.rows.filter((row) => row.ok).length;
    $('result-summary').textContent = `${result.rows.length} 只股票 · ${success} 只成功`;
    $('status').textContent = success === result.rows.length
      ? '行情已更新。每行日期和时间均按交易所时区显示。'
      : `${result.rows.length - success} 只查询失败，其余行情已显示；请检查 ticker 或稍后重试。`;
    $('updated-at').textContent = `获取时间（本机）：${new Date(result.fetchedAt).toLocaleString('zh-CN', { hour12: false })} · ${result.source}`;
    try { localStorage.setItem('stock-desk:tickers', value); } catch { /* optional persistence */ }
  } catch (error) {
    $('error').textContent = error.message || '查询失败，请稍后重试。';
    $('error').hidden = false;
    $('status').textContent = lastFetchedAt ? '更新失败，下方保留上次结果，请留意获取时间。' : '未能获取行情。';
  } finally { setBusy(false); }
}

$('quote-form').addEventListener('submit', (event) => {
  event.preventDefault();
  query(input.value.trim());
});
$('refresh-button').addEventListener('click', () => { if (lastInput) query(lastInput); });
$('tech-preset').addEventListener('click', () => { input.value = DEFAULT_TICKERS; input.focus(); });
setInterval(() => {
  if ($('auto-refresh').checked && lastInput && !busy && !document.hidden) query(lastInput);
}, 60_000);
