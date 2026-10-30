import { inCheck, type Color, type Position } from './engine';
export interface PlanUpdate {
  action: 'continue' | 'revise' | 'abandon'; reason: string;
  objective?: string; problem?: string; opponentThreat?: string; nextSteps?: string[]; abandonWhen?: string;
}
export interface StrategicPlan {
  color: Color; createdPly: number; reviewedPly: number; expiresAtPly: number;
  status: 'active' | 'needs-review' | 'invalidated' | 'abandoned';
  objective: string; problem: string; opponentThreat: string; nextSteps: string[]; abandonWhen: string;
  reviewReason: string;
}
function text(value: unknown, label: string, max = 160): string {
  if (typeof value !== 'string' || value.trim().length < 2 || value.length > max) throw new Error(`${label}须为 2–${max} 字`);
  return value.trim();
}
// These are public intentions, never a proof or a sequence to execute blindly.
// Updates are staged by GameService, and become durable ONLY with a legal move.
export function updatePlan(p: Position, previous: StrategicPlan | null, input: PlanUpdate): StrategicPlan | null {
  if (!input || !['continue', 'revise', 'abandon'].includes(input.action)) throw new Error('无效的计划更新动作');
  const reason = text(input.reason, '计划复核说明');
  if (input.action === 'abandon') return previous ? { ...structuredClone(previous), status: 'abandoned', reviewedPly: p.moves.length, reviewReason: reason } : null;
  if (input.action === 'continue') {
    if (!previous || previous.color !== p.next || ['invalidated', 'abandoned'].includes(previous.status) || p.moves.length >= previous.expiresAtPly) {
      throw new Error('没有可继续的有效计划，请重新制定（revise）');
    }
    if (inCheck(p.board, p.next)) throw new Error('当前被将军，须按当前威胁重新制定计划，不能直接沿用');
    return { ...structuredClone(previous), status: 'active', reviewedPly: p.moves.length, expiresAtPly: p.moves.length + 8,
      opponentThreat: input.opponentThreat === undefined ? previous.opponentThreat : text(input.opponentThreat, '对方计划'), reviewReason: reason };
  }
  if (!Array.isArray(input.nextSteps) || input.nextSteps.length < 1 || input.nextSteps.length > 3) throw new Error('近期步骤须为 1–3 项');
  return { color: p.next, createdPly: p.moves.length, reviewedPly: p.moves.length, expiresAtPly: p.moves.length + 8, status: 'active',
    objective: text(input.objective, '主要目标'), problem: text(input.problem, '当前问题'), opponentThreat: text(input.opponentThreat, '对方计划'),
    nextSteps: input.nextSteps.map(x => text(x, '近期步骤', 120)), abandonWhen: text(input.abandonWhen, '放弃条件'), reviewReason: reason };
}
export function planForPosition(plan: StrategicPlan | null, p: Position): StrategicPlan | null {
  if (!plan || plan.status === 'abandoned' || plan.status === 'invalidated') return plan ? structuredClone(plan) : null;
  const out = structuredClone(plan), last = p.moves.at(-1);
  if (p.winner || p.moves.length >= plan.expiresAtPly || inCheck(p.board, plan.color) || last && last.color !== plan.color && last.captured) {
    out.status = 'invalidated';
    out.reviewReason = p.winner ? '本局结束，计划失效' : p.moves.length >= plan.expiresAtPly ? '计划过期，须重新制定'
      : inCheck(p.board, plan.color) ? '对方将军，须优先处理当前威胁并重新制定' : '对方吃子改变局面，须重新制定';
  } else if (last?.color !== plan.color || plan.status === 'needs-review') {
    out.status = 'needs-review'; out.reviewReason = '对方已走子，须复核目标、对方威胁和放弃条件，不能照搬旧步骤';
  }
  return out;
}
