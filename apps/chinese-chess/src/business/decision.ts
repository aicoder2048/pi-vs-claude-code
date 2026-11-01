import { inCheck } from './engine';
import { inspectSafety, phaseOf } from './expert';
import type { GameState } from '../shared/types';

export const SKILLS_VERSION = 'xiangqi-skills/v3' as const;
export type Playbook = 'playbook-opening' | 'playbook-middlegame' | 'playbook-endgame' |
  'playbook-in-check' | 'playbook-under-attack' | 'playbook-time-pressure';
export interface TurnGuidance { playbook: Playbook; evidence: string }
export type DecisionStep = 'observe' | 'compare' | 'plan' | 'commit';
export interface DecisionTrace {
  version: 'xiangqi-skills/v1' | 'xiangqi-skills/v2' | typeof SKILLS_VERSION; revision: number; playbook: Playbook;
  skillsInjected: string[];
  /** Legacy v1/v2 read_skill audit. v3 leaves this empty; native reads appear in tools. */
  skillsRead: string[];
  tools: { name: string; ok: boolean }[];
  /** Optional structured public evidence; legacy records have only tool names. */
  audit?: import('./call-audit').TurnCallAudit;
  steps: { id: DecisionStep; status: 'done' | 'skipped'; evidence: string }[];
}
export function createDecisionTrace(revision: number, guidance: TurnGuidance): DecisionTrace {
  return { version: SKILLS_VERSION, revision, playbook: guidance.playbook,
    skillsInjected: ['xiangqi-coach'], skillsRead: [], tools: [],
    steps: (['observe', 'compare', 'plan', 'commit'] as const).map(id => ({
      id, status: id === 'observe' ? 'done' : 'skipped',
      evidence: id === 'observe' ? `已注入当前局面信号；${guidance.evidence}` : '尚无成功工具证据',
    })) };
}
export function recordDecisionTool(trace: DecisionTrace, name: string, ok: boolean): void {
  trace.tools.push({ name, ok });
  if (!ok) return;
  const step: DecisionStep | undefined = name === 'analyze_position' ? 'observe' :
    ['review_move', 'compare_moves', 'search_position'].includes(name) ? 'compare' :
    name === 'update_plan' ? 'plan' : ['move_piece', 'resign_game'].includes(name) ? 'commit' : undefined;
  if (step) Object.assign(trace.steps.find(s => s.id === step)!, { status: 'done', evidence: `${name} 执行成功` });
}
type TurnState = Pick<GameState, 'position' | 'analysis' | 'clock' | 'match' | 'notes' | 'outcome'>;

// Recommend a business workflow; Pi and the model handle skill loading.
// This is not a claim that the recommended move wins.
export function turnGuidance(state: TurnState): TurnGuidance | null {
  const { position: p } = state;
  if (p.winner || state.outcome) return null;
  if (inCheck(p.board, p.next)) return { playbook: 'playbook-in-check', evidence: '当前被将军' };
  const remaining = state.clock.players[p.next].mainMs;
  const recent = state.notes.slice(-8);
  const average = recent.length ? recent.reduce((sum, n) => sum + n.elapsedMs, 0) / recent.length : 0;
  const threshold = Math.max(60000, 3 * average, state.match.settings.timeControl === 'absolute' ? 90000 : 0);
  if (remaining < threshold) return { playbook: 'playbook-time-pressure', evidence: `余时 ${remaining}ms < ${threshold}ms` };
  const safety = state.analysis.expert?.safety ?? inspectSafety(p);
  const attacked = safety.filter(x => x.color === p.next && x.value >= 400 && x.legalAttackers.length);
  if (attacked.length) return { playbook: 'playbook-under-attack', evidence: attacked.map(x => x.piece).join('、') };
  const phase = phaseOf(p);
  return { playbook: `playbook-${phase}`, evidence: `阶段 ${phase}` };
}
