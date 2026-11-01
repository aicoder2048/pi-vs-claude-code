// Public diagnostic evidence, separate from reasoning and from chess authority.
export interface RequestAudit {
  number: number; phase: 'analysis' | 'submit'; status: 'running' | 'ok' | 'error' | 'interrupted';
  stopReason?: string; inputTokens?: number; outputTokens?: number; textChars?: number; toolCalls?: number;
}
export interface CallAudit {
  id: string; request: number; name: string; status: 'running' | 'ok' | 'error' | 'accepted' | 'interrupted';
  input: Record<string, unknown>; inputFingerprint: string;
  resultFingerprint?: string; evidenceFingerprint?: string; result?: Record<string, unknown>;
  sameInputAs?: string; sameResultAs?: string; sameEvidenceAs?: string;
}
export interface TurnCallAudit {
  version: 'xiangqi-call-audit/v1'; requests: RequestAudit[]; calls: CallAudit[];
  droppedRequests: number; droppedCalls: number;
}
// Called inside the authoritative commit/resign transaction: tool_execution_end
// occurs too late for the first autosave. Do not fabricate a returned-result hash.
export function settleCallAudit(audit: TurnCallAudit | undefined, terminal?: 'move_piece' | 'resign_game'): void {
  if (!audit) return;
  const accepted = terminal ? audit.calls.findLast(c => c.name === terminal && c.status === 'running') : undefined;
  if (accepted) { accepted.status = 'accepted'; accepted.result = { accepted: true, source: 'business-transaction' }; }
  for (const call of audit.calls) if (call.status === 'running') call.status = 'interrupted';
  for (const request of audit.requests) if (request.status === 'running') request.status = 'interrupted';
}
