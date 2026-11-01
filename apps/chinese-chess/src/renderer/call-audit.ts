import type { TurnCallAudit } from '../business/call-audit';
export function callAuditLines(audit?: TurnCallAudit): string[] {
  if (!audit) return ['此棋谱未记录结构化调用证据，不能仅凭工具名判断语义重复。'];
  const index = (id: string) => audit.calls.findIndex(c => c.id === id) + 1;
  return [
    '相同输入/相同结果是重复证据，不自动等于徒劳；确认、重算仍可能有价值。哈希不同也不能证明语义不同。',
    ...audit.requests.map(r => `请求 ${r.number} · ${r.phase === 'submit' ? '仅提交/认输' : '分析'} · ${r.stopReason ?? r.status} · 工具意图 ${r.toolCalls ?? '未知'} · tokens ${r.inputTokens ?? '?'}/${r.outputTokens ?? '?'}`),
    ...audit.calls.flatMap((c, i) => [
      `调用 #${i + 1} · 请求 ${c.request} · ${c.name} · ${c.status}${c.sameInputAs ? ` · 同输入 #${index(c.sameInputAs)}` : ''}${c.sameResultAs ? ` · 同结果 #${index(c.sameResultAs)}` : c.sameEvidenceAs ? ` · 同摘要证据 #${index(c.sameEvidenceAs)}` : ''}`,
      `输入摘要：${JSON.stringify(c.input)}`,
      ...(c.result ? [`结果摘要：${JSON.stringify(c.result)}`] : ['结果尚未记录；不推断为成功或无效。']),
    ]),
    ...(audit.droppedCalls || audit.droppedRequests ? [`容量限制：省略 ${audit.droppedCalls} 个调用、${audit.droppedRequests} 个请求。`] : []),
  ];
}
