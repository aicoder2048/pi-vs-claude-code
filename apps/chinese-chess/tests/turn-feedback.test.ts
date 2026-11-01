import { expect, test } from 'bun:test';
import { progressText, timingLines, timingSummary } from '../src/renderer/turn-feedback';
import type { TurnProgress, TurnTiming } from '../src/business/turn-timing';
const progress: TurnProgress = { revision: 1, phase: 'model', receiving: false, requests: 2, tools: 1, elapsedMs: 12000 };

test('public phase labels distinguish waiting, streaming, tools and independent review', () => {
  expect(progressText(progress)).toBe('等待模型响应 · 第2次 · 本回合 12.0秒');
  expect(progressText({ ...progress, receiving: true })).toContain('接收模型响应');
  for (const [name, text] of [['compare_moves', '比较候选'], ['analyze_position', '读取完整报告'], ['update_plan', '复核计划'], ['read_skill', '读取技能（旧版）'], ['read', '读取文件'], ['bash', '执行脚本'], ['edit', '编辑文件'], ['write', '写入文件'], ['resign_game', '主动认输']]) {
    expect(progressText({ ...progress, phase: 'tool', name })).toContain(text);
  }
  expect(progressText({ ...progress, phase: 'review' })).toContain('提交复查');
  expect(progressText({ ...progress, phase: 'pre-search' })).toContain('局面预搜索');
  expect(progressText({ ...progress, phase: 'setup' })).toContain('准备会话');
});
test('timing display reports missing first delta honestly and uses host-only durations', () => {
  const timing: TurnTiming = { version: 'xiangqi-timing/v1', totalMs: 12000,
    breakdown: { modelMs: 10000, toolMs: 1000, reviewMs: 500, preSearchMs: 400, otherMs: 100 },
    spans: [{ id: 'm', kind: 'model', name: 'request-1', startMs: 0, durationMs: 10000, status: 'interrupted' }] };
  expect(timingSummary(timing)).toContain('模型往返 10.0秒（1次）');
  const lines = timingLines(timing).join('\n');
  expect(lines).toContain('总计 12.0秒'); expect(lines).toContain('首次响应增量 未观测到');
  expect(lines).toContain('不是纯思考'); expect(lines).toContain('中断');
  timing.spans[0].firstDeltaMs = 0;
  expect(timingLines(timing).join('\n')).toContain('首次响应增量 0.0秒');
});
