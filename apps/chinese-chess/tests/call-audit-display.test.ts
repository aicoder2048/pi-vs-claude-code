import { expect, test } from 'bun:test';
import { callAuditLines } from '../src/renderer/call-audit';
import { CallAuditRecorder } from '../src/agent/call-audit';
test('public audit display explains repeated reads without claiming they are futile', () => {
  const audit = new CallAuditRecorder('/workspace');
  audit.startRequest(1, false); audit.startRequest(9, true);
  for (const id of ['a', 'b']) {
    audit.startCall(id, 1, 'read', { path: 'skills/coach/SKILL.md', offset: 20, limit: 10 });
    audit.endCall(id, { content: [{ type: 'text', text: 'private file text' }] }, false);
  }
  const lines = callAuditLines(audit.data).join('\n');
  expect(lines).toContain('请求 9 · 仅提交/认输'); expect(lines).toContain('同输入 #1'); expect(lines).toContain('同结果 #1');
  expect(lines).toContain('skills/coach/SKILL.md'); expect(lines).toContain('不自动等于徒劳');
  expect(lines).not.toContain('private file text');
  expect(callAuditLines().join('\n')).toContain('未记录结构化调用证据');
});
