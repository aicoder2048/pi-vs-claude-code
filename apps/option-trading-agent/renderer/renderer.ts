import type { AgentView } from '../src/business/types.ts';
import type { DesktopBridge, DesktopCommand } from '../src/desktop.ts';

declare global {
  interface Window { optionAgent: DesktopBridge }
}

function element(id: string): HTMLElement {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing desktop element ${id}.`);
  return result;
}

function button(id: string): HTMLButtonElement {
  const result = element(id);
  if (!(result instanceof HTMLButtonElement)) throw new Error(`Invalid button ${id}.`);
  return result;
}

const question = element('question');
if (!(question instanceof HTMLTextAreaElement)) throw new Error('Missing question input.');
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
  stop.disabled = !view || !['ready', 'starting'].includes(view.connection.kind) || pending === 'stop' || pending === 'restart';
  restart.disabled = !view || transitioning || pending !== null || ready && !idle;
  const stateError = view?.connection.kind === 'failed' ? view.connection.error
    : view?.operation.kind === 'failed' ? view.operation.error : '';
  errorBox.textContent = commandError || stateError;
  errorBox.hidden = !errorBox.textContent;
}

function render(next: AgentView): void {
  view = next;
  element('connection').textContent = {
    new: 'Pi not started', starting: 'Starting Pi…', ready: 'Pi ready', closing: 'Stopping Pi…', stopped: 'Pi stopped', failed: 'Pi failed',
  }[next.connection.kind];
  element('model').textContent = next.connection.kind === 'ready' ? next.connection.model : '';
  element('operation').textContent = next.operation.kind === 'advice'
    ? `Working · ${next.operation.turns} turns · ${next.operation.tools} tool calls`
    : next.operation.kind === 'command' ? 'Running command…'
    : next.operation.kind === 'failed' ? 'Operation failed'
    : next.connection.kind === 'ready' ? 'Ready for a question' : 'Session not ready';

  const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 50;
  transcript.replaceChildren();
  if (!next.messages.length) transcript.append(text('p', 'Ask a question to start. Nothing is sent automatically.', 'empty'));
  for (const message of next.messages) {
    const article = document.createElement('article');
    article.className = `message ${message.role} ${message.status}`;
    article.append(text('h3', `${message.role === 'user' ? 'You' : 'Agent'}${message.status === 'complete' ? '' : ` · ${message.status}`}`));
    article.append(text('p', message.text || '…', 'message-text'));
    transcript.append(article);
  }
  if (atBottom) transcript.scrollTop = transcript.scrollHeight;

  tools.replaceChildren();
  if (!next.tools.length) tools.append(text('p', 'No tools have run.', 'empty'));
  for (const tool of next.tools) {
    const article = document.createElement('article');
    article.className = `tool ${tool.kind}`;
    article.append(text('h3', `${tool.name} · ${tool.kind}`));
    article.append(text('p', tool.id, 'muted tool-id'));
    article.append(text('pre', JSON.stringify(tool.input, null, 2) ?? 'No input'));
    if (tool.kind === 'succeeded') article.append(text('pre', tool.text));
    if (tool.kind === 'failed') article.append(text('pre', tool.error, 'tool-error'));
    tools.append(article);
  }
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
    commandError = error instanceof Error ? error.message : 'The desktop connection failed.';
    return false;
  } finally {
    if (pending === command.kind) pending = null;
    controls();
  }
}

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
  commandError = error instanceof Error ? error.message : 'Cannot read the desktop state.';
  controls();
});
window.addEventListener('beforeunload', unsubscribe, { once: true });
