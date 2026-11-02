import type { AgentView, DataResult, MarketPanel, MarketQuery } from '../src/business/types.ts';
import type { DesktopBridge, DesktopCommand } from '../src/desktop.ts';

declare global {
  interface Window { optionAgent: DesktopBridge }
}

function element(id: string): HTMLElement {
  const result = document.getElementById(id);
  if (!result) throw new Error(`缺少桌面元素 ${id}。`);
  return result;
}

function button(id: string): HTMLButtonElement {
  const result = element(id);
  if (!(result instanceof HTMLButtonElement)) throw new Error(`按钮 ${id} 无效。`);
  return result;
}

function input(id: string): HTMLInputElement {
  const result = element(id);
  if (!(result instanceof HTMLInputElement)) throw new Error(`输入框 ${id} 无效。`);
  return result;
}

function select(id: string): HTMLSelectElement {
  const result = element(id);
  if (!(result instanceof HTMLSelectElement)) throw new Error(`下拉框 ${id} 无效。`);
  return result;
}

const symbol = input('symbol');
const days = input('days');
const expiry = input('expiry');
const strikeMin = input('strike-min');
const strikeMax = input('strike-max');
const loadMarket = button('load-market');
const displayExpiry = select('display-expiry');
const displaySide = select('display-side');
let displayedQuery = '';
let marketSignature = '';

const question = element('question');
if (!(question instanceof HTMLTextAreaElement)) throw new Error('缺少问题输入框。');
const draft = question;
const send = button('send');
const stop = button('stop');
const restart = button('restart');
const transcript = element('transcript');
const tools = element('tools');
const errorBox = element('error');
let view: AgentView | null = null;
let pending: DesktopCommand['kind'] | null = null;
let commandError = '';
let updates = 0;

function text(tag: string, content: string, className = ''): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = content;
  node.className = className;
  return node;
}

function controls(): void {
  const ready = view?.connection.kind === 'ready';
  const idle = view?.operation.kind === 'idle';
  const transitioning = view?.connection.kind === 'starting' || view?.connection.kind === 'closing';
  send.disabled = !ready || !idle || pending !== null || !draft.value.trim();
  loadMarket.disabled = !ready || !idle || pending !== null;
  stop.disabled = !view || !['ready', 'starting'].includes(view.connection.kind) || pending === 'stop' || pending === 'restart';
  restart.disabled = !view || transitioning || pending !== null || ready && !idle;
  const stateError = view?.connection.kind === 'failed' ? view.connection.error
    : view?.operation.kind === 'failed' ? view.operation.error : '';
  errorBox.textContent = commandError || stateError ? `错误：${commandError || stateError}` : '';
  errorBox.hidden = !errorBox.textContent;
}

function metadata<T>(id: string, result: DataResult<T> | null): void {
  const container = element(id);
  container.replaceChildren();
  if (!result) { container.append(text('p', '尚未加载。', 'muted')); return; }
  const statuses = {
    ok: '正常', partial: '部分数据', empty: '无数据', unavailable: '不可用', error: '错误',
  } satisfies Record<DataResult<T>['status'], string>;
  const sources = { network: '网络', cache: '缓存' } satisfies Record<DataResult<T>['source'], string>;
  container.append(text('p', `状态 · ${statuses[result.status]}`, `result-status ${result.status}`));
  const entries = [
    ['提供商', result.provider], ['来源', sources[result.source]],
    ['数据截至', result.asOf ?? '缺失'], ['获取时间', result.fetchedAt],
  ];
  const details = document.createElement('dl');
  for (const [name, value] of entries) details.append(text('dt', name), text('dd', value));
  container.append(details);
  const issues = document.createElement('ul');
  issues.className = 'result-issues';
  for (const issue of result.issues) issues.append(text('li', issue));
  container.append(text('p', result.issues.length ? '问题提示' : '问题提示 · 暂无', 'muted'), issues);
}

function number(value: number | null): string {
  return value === null ? '缺失' : String(value);
}

function row(values: string[]): HTMLElement {
  const node = document.createElement('tr');
  for (const value of values) node.append(text('td', value));
  return node;
}

function renderChain(panel: MarketPanel | null): void {
  const rows = panel?.chain.rows ?? [];
  const visible = rows.filter(item => item.expiry === displayExpiry.value &&
    (displaySide.value === 'all' || item.side === displaySide.value));
  element('chain-rows').replaceChildren(...visible.map(item => row([
    item.occ, item.expiry, item.side.toUpperCase(), number(item.strike), number(item.bid), number(item.ask),
    item.iv === null ? '缺失' : `${Number((item.iv * 100).toFixed(4))}%`,
    number(item.greeks.delta), number(item.greeks.gamma), number(item.greeks.theta), number(item.greeks.vega),
    number(item.openInterest), item.quotedAt ?? '缺失',
  ])));
  const expiryCount = rows.filter(item => item.expiry === displayExpiry.value).length;
  element('chain-count').textContent = `显示 ${visible.length} 行 / 所选到期日 ${expiryCount} 行 / 共返回 ${rows.length} 行。仅按到期日和 PUT/CALL 本地筛选。`;
}

function renderMarket(panel: MarketPanel | null): void {
  const signature = JSON.stringify(panel);
  if (signature === marketSignature) return;
  marketSignature = signature;
  const queryKey = panel ? JSON.stringify(panel.query) : '';
  const expiries = [...new Set(panel?.chain.rows.map(item => item.expiry) ?? [])].sort();
  const selected = queryKey === displayedQuery && expiries.includes(displayExpiry.value)
    ? displayExpiry.value : panel?.query.expiry ?? expiries[0] ?? '';
  displayedQuery = queryKey;
  displayExpiry.replaceChildren();
  for (const value of expiries) {
    const option = document.createElement('option');
    option.value = value; option.textContent = value;
    displayExpiry.append(option);
  }
  if (!expiries.length) {
    const option = document.createElement('option');
    option.value = ''; option.textContent = '暂无返回的到期日';
    displayExpiry.append(option);
  }
  displayExpiry.value = selected;
  displayExpiry.disabled = !expiries.length;
  displaySide.disabled = !expiries.length;
  element('loaded-query').textContent = panel
    ? `已加载 ${panel.symbol} · 请求 ${panel.query.days} 天日线 · ${panel.query.expiry ? `到期日 ${panel.query.expiry}` : '请求全部到期日'} · ${panel.query.strikeRange ? `行权价 ${panel.query.strikeRange.min} 至 ${panel.query.strikeRange.max}` : '请求全部行权价'}`
    : '尚未加载行情数据。';
  metadata('bars-metadata', panel?.bars ?? null);
  metadata('chain-metadata', panel?.chain ?? null);
  const bars = panel?.bars.rows ?? [];
  element('bars-rows').replaceChildren(...bars.map(item => row([
    item.date, number(item.open), number(item.high), number(item.low), number(item.close), number(item.volume),
    item.provisional ? '是' : '否',
  ])));
  element('bars-count').textContent = `显示 ${bars.length} 行 / 返回 ${bars.length} 行 / 请求 ${panel?.query.days ?? 0} 天。未设置本地行数上限。`;
  renderChain(panel);
}

function render(next: AgentView): void {
  view = next;
  element('connection').textContent = {
    new: 'Pi 尚未启动', starting: '正在启动 Pi…', ready: 'Pi 已就绪', closing: '正在停止 Pi…', stopped: 'Pi 已停止', failed: 'Pi 运行失败',
  }[next.connection.kind];
  element('model').textContent = next.connection.kind === 'ready' ? next.connection.model : '';
  element('operation').textContent = next.operation.kind === 'advice'
    ? `处理中 · ${next.operation.turns} 轮 · ${next.operation.tools} 次工具调用`
    : next.operation.kind === 'command' ? '正在执行命令…'
    : next.operation.kind === 'failed' ? '操作失败'
    : next.connection.kind === 'ready' ? '可以提问' : '会话尚未就绪';

  const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 50;
  transcript.replaceChildren();
  if (!next.messages.length) transcript.append(text('p', '输入问题开始对话。系统不会自动发送任何内容。', 'empty'));
  for (const message of next.messages) {
    const article = document.createElement('article');
    article.className = `message ${message.role} ${message.status}`;
    const statuses = { streaming: '生成中', complete: '已完成', failed: '失败' } satisfies Record<typeof message.status, string>;
    article.append(text('h3', `${message.role === 'user' ? '你' : '助理'}${message.status === 'complete' ? '' : ` · ${statuses[message.status]}`}`));
    article.append(text('p', message.text || '…', 'message-text'));
    transcript.append(article);
  }
  if (atBottom) transcript.scrollTop = transcript.scrollHeight;

  tools.replaceChildren();
  if (!next.tools.length) tools.append(text('p', '尚未调用工具。', 'empty'));
  for (const tool of next.tools) {
    const article = document.createElement('article');
    article.className = `tool ${tool.kind}`;
    const statuses = { running: '执行中', succeeded: '成功', failed: '失败' } satisfies Record<typeof tool.kind, string>;
    article.append(text('h3', `${tool.name} · ${statuses[tool.kind]}`));
    article.append(text('p', tool.id, 'muted tool-id'));
    article.append(text('p', '工具输入', 'muted'), text('pre', JSON.stringify(tool.input, null, 2) ?? '无输入'));
    if (tool.kind === 'succeeded') article.append(text('p', '工具结果', 'muted'), text('pre', tool.text));
    if (tool.kind === 'failed') article.append(text('p', '工具错误', 'muted'), text('pre', tool.error, 'tool-error'));
    tools.append(article);
  }
  renderMarket(next.market);
  controls();
}

async function submit(command: DesktopCommand): Promise<boolean> {
  pending = command.kind;
  commandError = '';
  controls();
  try {
    const result = await window.optionAgent.send(command);
    if (result.kind === 'error') { commandError = result.error; return false; }
    return true;
  } catch (error) {
    commandError = error instanceof Error ? error.message : '桌面连接失败。';
    return false;
  } finally {
    if (pending === command.kind) pending = null;
    controls();
  }
}

element('market-form').addEventListener('submit', event => {
  event.preventDefault();
  if (loadMarket.disabled) return;
  if (!!strikeMin.value !== !!strikeMax.value) {
    commandError = '请同时填写最低和最高行权价，或将两项都留空。';
    controls();
    return;
  }
  const query: MarketQuery = {
    symbol: symbol.value, days: days.valueAsNumber,
    ...(expiry.value ? { expiry: expiry.value } : {}),
    ...(strikeMin.value && strikeMax.value ? { strikeRange: { min: strikeMin.valueAsNumber, max: strikeMax.valueAsNumber } } : {}),
  };
  void submit({ kind: 'market', query });
});
displayExpiry.addEventListener('change', () => renderChain(view?.market ?? null));
displaySide.addEventListener('change', () => renderChain(view?.market ?? null));

element('question-form').addEventListener('submit', event => {
  event.preventDefault();
  if (send.disabled) return;
  const value = draft.value;
  draft.value = '';
  void submit({ kind: 'ask', text: value }).then(ok => {
    if (!ok && !draft.value) draft.value = value;
    controls();
    draft.focus();
  });
});
draft.addEventListener('input', controls);
stop.addEventListener('click', () => { void submit({ kind: 'stop' }); });
restart.addEventListener('click', () => { void submit({ kind: 'restart' }); });

const unsubscribe = window.optionAgent.subscribe(next => { updates++; render(next); });
const initialUpdates = updates;
void window.optionAgent.view().then(next => {
  if (updates === initialUpdates) render(next);
}).catch(error => {
  commandError = error instanceof Error ? error.message : '无法读取桌面状态。';
  controls();
});
window.addEventListener('beforeunload', unsubscribe, { once: true });
