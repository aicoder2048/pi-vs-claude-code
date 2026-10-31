import type { TurnProgress, TurnTiming } from '../business/turn-timing';
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}秒`;
const tools: Record<string, string> = {
  analyze_position: '读取完整报告', read_skill: '读取技能', review_move: '审查候选',
  compare_moves: '比较候选', search_position: '搜索变化', simulate_moves: '验证变化',
  update_plan: '复核计划', move_piece: '提交走子',
};
export function progressText(progress: TurnProgress): string {
  const phase = progress.phase === 'model' ? `${progress.receiving ? '接收模型响应' : '等待模型响应'} · 第${progress.requests}次` :
    progress.phase === 'review' ? '提交复查' : progress.phase === 'pre-search' ? '局面预搜索' :
    progress.phase === 'tool' ? tools[progress.name ?? ''] ?? '执行业务工具' : '准备会话';
  return `${phase} · 本回合 ${seconds(progress.elapsedMs)}`;
}
export function timingSummary(timing: TurnTiming): string {
  const b = timing.breakdown, requests = timing.spans.filter(s => s.kind === 'model').length;
  return `模型往返 ${seconds(b.modelMs)}（${requests}次） · 工具 ${seconds(b.toolMs)} · 预搜索 ${seconds(b.preSearchMs)} · 提交复查 ${seconds(b.reviewMs)} · 其他 ${seconds(b.otherMs)}`;
}
export function timingLines(timing: TurnTiming): string[] {
  const status = { running: '进行中', ok: '完成', error: '失败', interrupted: '中断' };
  return [
    `总计 ${seconds(timing.totalMs)}；${timingSummary(timing)}`,
    '模型往返含网络、排队、生成与SDK开销，不是纯思考。汇总已扣除工具内嵌的提交复查，不能再把下列原始区间直接相加。',
    ...timing.spans.map(s => {
      const name = s.kind === 'model' ? `模型请求 ${s.name.replace('request-', '')}` : s.kind === 'tool' ? `${tools[s.name] ?? '业务工具'} (${s.name})` :
        s.kind === 'review' ? '独立提交复查' : s.kind === 'pre-search' ? '宿主预搜索' : '会话准备';
      const first = s.kind === 'model' ? `；首次响应增量 ${s.firstDeltaMs === undefined ? '未观测到' : seconds(s.firstDeltaMs)}` : '';
      return `${name} · ${seconds(s.durationMs)} · ${status[s.status]}${first}`;
    }),
  ];
}
