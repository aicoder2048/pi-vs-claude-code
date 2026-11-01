import { createHash } from 'node:crypto';
import path from 'node:path';
import type { TurnCallAudit } from '../business/call-audit';

export const MAX_AUDIT_CALLS = 64;
export const MAX_AUDIT_REQUESTS = 32;
const object = (v: any): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const text = (v: unknown) => typeof v === 'string' ? v.slice(0, 160) : undefined;
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
// Canonical key order makes argument property order irrelevant. Hashes, not raw
// values, retain exact identity for shell commands, edit contents and read text.
function canonical(v: any): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const compact = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).filter(([, value]) => value !== undefined));
function move(v: any): unknown {
  const p = object(v), from = object(p.from), to = object(p.to);
  return compact({ from: compact({ x: number(from.x), y: number(from.y) }), to: compact({ x: number(to.x), y: number(to.y) }) });
}
function plan(v: any): Record<string, unknown> {
  const p = object(v);
  return compact({ ...Object.fromEntries(['action', 'reason', 'objective', 'problem', 'opponentThreat', 'abandonWhen', 'status'].map(k => [k, text(p[k])])),
    nextSteps: Array.isArray(p.nextSteps) ? p.nextSteps.slice(0, 3).map(text) : undefined });
}
function coverage(v: any): Record<string, unknown> {
  const p = object(v);
  return compact(Object.fromEntries(['checkedReplies', 'totalReplies', 'complete', 'exchangeComplete', 'reviewedMoves', 'totalMoves', 'budgetExhausted'].map(k =>
    [k, typeof p[k] === 'boolean' ? p[k] : number(p[k])])));
}
function search(v: any): Record<string, unknown> {
  const p = object(v);
  return compact({ completedDepth: number(p.completedDepth), attemptedDepth: number(p.attemptedDepth), rootScope: text(p.rootScope),
    stopped: text(p.stopped), legalRoots: number(p.legalRoots), searchedRoots: number(p.searchedRoots),
    candidates: Array.isArray(p.candidates) ? p.candidates.slice(0, 6).map((c: any) => compact({ move: move(c.move), score: number(c.score),
      pv: Array.isArray(c.pv) ? c.pv.slice(0, 12).map(move) : undefined })) : undefined });
}
function review(v: any): Record<string, unknown> {
  const p = object(v);
  return compact({ move: move(p.move), risk: text(p.risk), score: number(p.score), estimatedNet: number(p.estimatedNet),
    coverage: coverage(p.coverage), variation: Array.isArray(p.variation) ? p.variation.slice(0, 12).map(move) : undefined });
}

export class CallAuditRecorder {
  readonly data: TurnCallAudit = { version: 'xiangqi-call-audit/v1', requests: [], calls: [], droppedCalls: 0, droppedRequests: 0 };
  constructor(private cwd: string) {}
  private readPath(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const relative = path.relative(this.cwd, path.resolve(this.cwd, value)).split(path.sep).join('/');
    // Only logical bundled Markdown paths are public. No realpath lookup, file
    // read or raw absolute path is needed for diagnostics (not a sandbox).
    return relative.length <= 320 && /^skills\/(?!.*(?:^|\/)\.)[\w./-]+\.md$/.test(relative) ? relative : undefined;
  }
  startRequest(n: number, submit: boolean): void {
    if (this.data.requests.length >= MAX_AUDIT_REQUESTS) { this.data.droppedRequests++; return; }
    this.data.requests.push({ number: n, phase: submit ? 'submit' : 'analysis', status: 'running' });
  }
  endRequest(n: number, message: any): void {
    const request = this.data.requests.find(r => r.number === n);
    if (!request) return;
    request.status = ['error', 'aborted'].includes(message.stopReason) ? 'error' : 'ok';
    request.stopReason = text(message.stopReason);
    request.inputTokens = number(message.usage?.input); request.outputTokens = number(message.usage?.output);
    request.textChars = (message.content ?? []).reduce((sum: number, c: any) => sum + (c.type === 'text' && typeof c.text === 'string' ? c.text.length : 0), 0);
    request.toolCalls = (message.content ?? []).filter((c: any) => c.type === 'toolCall').length;
    // Never copy text/thinking/signatures, headers, prompts or credentials.
  }
  startCall(id: string, request: number, name: string, args: unknown): void {
    if (this.data.calls.some(c => c.id === id)) return;
    if (this.data.calls.length >= MAX_AUDIT_CALLS || id.length > 512) { this.data.droppedCalls++; return; }
    const p = object(args), publicPath = this.readPath(p.path);
    let input: Record<string, unknown> = {};
    let identity: unknown = args;
    if (name === 'read') {
      input = { path: publicPath ?? '[redacted]', offset: number(p.offset) ?? 1, limit: number(p.limit) ?? null };
      identity = { ...input, path: publicPath ?? p.path };
    } else if (['write', 'edit'].includes(name)) input = { path: publicPath ?? '[redacted]' };
    else if (name === 'bash') input = compact({ timeout: number(p.timeout), commandStored: false });
    else if (name === 'update_plan') {
      input = { ...plan(p), nextSteps: Array.isArray(p.nextSteps) ? p.nextSteps.slice(0, 3).map(text) : undefined };
    } else if (['move_piece', 'review_move', 'resign_game', 'compare_moves', 'simulate_moves', 'search_position'].includes(name)) {
      input = compact({ ...(p.from || p.to ? object(move(p)) : {}), revision: number(p.revision),
        moves: Array.isArray(p.moves) ? p.moves.slice(0, 6).map(move) : undefined, maxMs: number(p.maxMs), maxDepth: number(p.maxDepth),
        reason: name === 'resign_game' || name === 'move_piece' ? text(p.reason) : undefined });
    }
    const inputFingerprint = hash(identity);
    const previous = this.data.calls.findLast(c => c.name === name && c.inputFingerprint === inputFingerprint);
    this.data.calls.push({ id, request, name: name.slice(0, 80), input, inputFingerprint, status: 'running',
      ...(previous ? { sameInputAs: previous.id } : {}) });
  }
  endCall(id: string, result: any, isError: boolean): void {
    const call = this.data.calls.find(c => c.id === id);
    if (!call || call.status !== 'running') return;
    call.status = isError ? 'error' : 'ok';
    // Hash only tool-returned data, never assistant reasoning. Do not store the
    // text itself: native read/bash may return arbitrary project/private files.
    call.resultFingerprint = hash({ content: result?.content ?? [], isError });
    const p = object(result?.details);
    let summary: Record<string, unknown> = {};
    if (call.name === 'search_position') summary = { search: search(p.search) };
    else if (call.name === 'review_move' || (call.name === 'move_piece' && p.review)) summary = { review: review(p.review) };
    else if (call.name === 'compare_moves') summary = { reviews: Array.isArray(p.reviews) ? p.reviews.slice(0, 6).map(review) : [] };
    else if (call.name === 'update_plan') summary = { plan: plan(p.plan), staged: p.staged === true };
    else if (['analyze_position', 'simulate_moves'].includes(call.name)) {
      const a = object(p.analysis), expert = object(a.expert);
      summary = compact({ ply: number(a.ply), next: number(a.next), inCheck: typeof a.inCheck === 'boolean' ? a.inCheck : undefined,
        legalMoves: Array.isArray(a.legalMoves) ? a.legalMoves.length : undefined, coverage: coverage(expert.coverage),
        candidates: Array.isArray(expert.candidates) ? expert.candidates.slice(0, 6).map(review) : undefined });
    } else summary = { textChars: (result?.content ?? []).reduce((n: number, c: any) => n + (c.type === 'text' && typeof c.text === 'string' ? c.text.length : 0), 0) };
    const evidence = { ...summary, isError };
    call.result = canonical(evidence).length <= 6000 ? evidence : { summaryOmitted: 'size-limit', isError };
    // For native tools, a length alone is NOT evidence of equivalent results.
    const structured = ['search_position', 'review_move', 'compare_moves', 'update_plan', 'analyze_position', 'simulate_moves'].includes(call.name);
    call.evidenceFingerprint = ((!isError && structured) || p.review) ? hash(evidence) : call.resultFingerprint;
    // Reconcile in START order even when parallel tools finish in reverse order.
    for (const [i, current] of this.data.calls.entries()) {
      if (!current.resultFingerprint) continue;
      const previous = this.data.calls.slice(0, i).findLast(c => c.name === current.name &&
        c.inputFingerprint === current.inputFingerprint && !!c.resultFingerprint);
      if (previous?.resultFingerprint === current.resultFingerprint) current.sameResultAs = previous.id;
      if (previous && previous.evidenceFingerprint === current.evidenceFingerprint) current.sameEvidenceAs = previous.id;
    }
  }
}
