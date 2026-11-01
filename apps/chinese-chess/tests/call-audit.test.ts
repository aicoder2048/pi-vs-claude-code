import { expect, test } from 'bun:test';
import { CallAuditRecorder, MAX_AUDIT_CALLS, MAX_AUDIT_REQUESTS } from '../src/agent/call-audit';
import { settleCallAudit } from '../src/business/call-audit';
const returned = (value: unknown) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], details: value });

test('read evidence normalizes workspace paths, distinguishes ranges and changed contents', () => {
  const audit = new CallAuditRecorder('/workspace');
  audit.startCall('a', 1, 'read', { path: 'skills/coach/SKILL.md' }); audit.endCall('a', returned('first'), false);
  audit.startCall('b', 2, 'read', { path: '/workspace/skills/coach/SKILL.md', offset: 1 }); audit.endCall('b', returned('first'), false);
  audit.startCall('c', 3, 'read', { path: './skills/coach/SKILL.md' }); audit.endCall('c', returned('changed'), false);
  audit.startCall('d', 4, 'read', { path: 'skills/coach/SKILL.md', offset: 30 }); audit.endCall('d', returned('first'), false);
  const [a, b, c, d] = audit.data.calls;
  expect(a.input.path).toBe('skills/coach/SKILL.md'); expect(b.sameInputAs).toBe('a'); expect(b.sameResultAs).toBe('a');
  expect(c.sameInputAs).toBe('b'); expect(c.sameResultAs).toBeUndefined(); expect(d.sameInputAs).toBeUndefined();
  expect(JSON.stringify(audit.data)).not.toContain('changed');
});
test('audit omits private reads, shell/write/edit contents, assistant text and all thinking', () => {
  const audit = new CallAuditRecorder('/workspace');
  for (const [id, name, args] of [
    ['a', 'read', { path: '/private/auth.json' }], ['b', 'bash', { command: 'echo SECRET_COMMAND' }],
    ['c', 'write', { path: '/private/SECRET_PATH', content: 'SECRET_CONTENT' }],
    ['d', 'edit', { path: '.env', edits: [{ oldText: 'SECRET_OLD', newText: 'SECRET_NEW' }] }],
  ] as const) { audit.startCall(id, 1, name, args); audit.endCall(id, returned('SECRET_RESULT'), false); }
  audit.startRequest(1, false);
  audit.endRequest(1, { stopReason: 'toolUse', usage: { input: 20, output: 10 }, content: [
    { type: 'text', text: 'SECRET_PROSE' }, { type: 'thinking', thinking: 'SECRET_THINKING', thinkingSignature: 'SECRET_SIGNATURE' },
    { type: 'toolCall', name: 'read' },
  ] });
  const saved = JSON.stringify(audit.data);
  expect(saved).not.toContain('SECRET'); expect(saved).not.toContain('/private'); expect(saved).not.toContain('.env');
  expect(audit.data.requests[0]).toMatchObject({ inputTokens: 20, outputTokens: 10, textChars: 12, toolCalls: 1 });
});
test('analysis evidence preserves candidates, depth and score but ignores volatile search time', () => {
  const audit = new CallAuditRecorder('/workspace'), move = { from: { x: 0, y: 3 }, to: { x: 0, y: 4 } };
  const search = { completedDepth: 3, rootScope: 'requested-subset', stopped: 'time', candidates: [{ move, score: 42, pv: [move] }] };
  audit.startCall('a', 1, 'search_position', { moves: [move], maxMs: 100 });
  audit.endCall('a', returned({ search: { ...search, elapsedMs: 100 } }), false);
  audit.startCall('b', 2, 'search_position', { maxMs: 100, moves: [move] });
  audit.endCall('b', returned({ search: { ...search, elapsedMs: 101 } }), false);
  audit.startCall('c', 3, 'search_position', { moves: [move], maxMs: 200 });
  audit.endCall('c', returned({ search: { ...search, completedDepth: 4 } }), false);
  expect(audit.data.calls[1].sameInputAs).toBe('a'); expect(audit.data.calls[1].sameResultAs).toBeUndefined();
  expect(audit.data.calls[1].sameEvidenceAs).toBe('a'); expect(audit.data.calls[2].sameInputAs).toBeUndefined();
  expect(audit.data.calls[2].result?.search).toMatchObject({ completedDepth: 4 });
});
test('parallel calls retain start order, request identity, and errors differ from success', () => {
  const audit = new CallAuditRecorder('/workspace');
  audit.startCall('a', 2, 'read', { path: 'skills/coach/SKILL.md' });
  audit.startCall('b', 2, 'read', { path: 'skills/coach/SKILL.md' });
  audit.endCall('b', returned('same'), false); audit.endCall('a', returned('same'), false);
  expect(audit.data.calls.map(c => c.id)).toEqual(['a', 'b']); expect(audit.data.calls[1].sameResultAs).toBe('a');
  audit.startCall('c', 3, 'read', { path: 'skills/coach/SKILL.md' }); audit.endCall('c', returned('same'), true);
  expect(audit.data.calls[2].status).toBe('error'); expect(audit.data.calls[2].sameResultAs).toBeUndefined();
});
test('plan evidence retains bounded public objectives and next steps for meaningful comparison', () => {
  const audit = new CallAuditRecorder('/workspace');
  const first = { action: 'revise', reason: '先保护受攻子力', objective: '协调车马', nextSteps: ['避开炮线'] };
  audit.startCall('a', 1, 'update_plan', first);
  audit.endCall('a', returned({ plan: { ...first, status: 'active' }, staged: true }), false);
  const second = { ...first, reason: '重新评估后调整', objective: '应对双攻', nextSteps: ['兑换进攻马'] };
  audit.startCall('b', 2, 'update_plan', second);
  audit.endCall('b', returned({ plan: { ...second, status: 'active' }, staged: true }), false);
  expect(audit.data.calls[1].input).toMatchObject({ action: 'revise', objective: '应对双攻', nextSteps: ['兑换进攻马'] });
  expect(audit.data.calls[1].result?.plan).toMatchObject({ objective: '应对双攻', nextSteps: ['兑换进攻马'] });
  expect(audit.data.calls[1].sameInputAs).toBeUndefined();
  expect(audit.data.calls[1].evidenceFingerprint).not.toBe(audit.data.calls[0].evidenceFingerprint);
  audit.startCall('long', 3, 'read', { path: 'skills/' + 'a'.repeat(400) + '.md' });
  expect(audit.data.calls[2].input.path).toBe('[redacted]');
  audit.startCall('x'.repeat(513), 3, 'read', {});
  expect(audit.data.droppedCalls).toBe(1);
});
test('bounded records disclose omissions; transaction acceptance and cancellation are explicit', () => {
  const audit = new CallAuditRecorder('/workspace');
  for (let n = 1; n <= MAX_AUDIT_REQUESTS + 2; n++) audit.startRequest(n, n > 8);
  audit.startCall('terminal', 9, 'move_piece', { from: { x: 0, y: 3 }, to: { x: 0, y: 4 } });
  for (let n = 0; n < MAX_AUDIT_CALLS + 1; n++) audit.startCall(`c-${n}`, 9, 'read', { path: 'skills/coach/SKILL.md' });
  expect(audit.data.requests).toHaveLength(MAX_AUDIT_REQUESTS); expect(audit.data.droppedRequests).toBe(2);
  expect(audit.data.calls).toHaveLength(MAX_AUDIT_CALLS); expect(audit.data.droppedCalls).toBe(2);
  settleCallAudit(audit.data, 'move_piece');
  expect(audit.data.calls[0].status).toBe('accepted'); expect(audit.data.calls[0].resultFingerprint).toBeUndefined();
  expect(audit.data.calls[1].status).toBe('interrupted'); expect(audit.data.requests[0].status).toBe('interrupted');
});
