import { chargeClock } from './clock';
import { RULESET, coordinate, play, type Point, type Position } from './rules';
import { analyze, type Analysis } from './tactics';
import type { GameState } from '../shared/types';
import type { ForcingCheck } from './forcing';

export const KNOWLEDGE_VERSION = 'gomoku-knowledge/v2' as const;
export const KNOWLEDGE_ITEMS = {
  'gomoku-coach': { file: 'SKILL.md', description: '每回合入口：获取事实、按剧本决策、提交前验证。' },
  'principle-rules': { file: 'principles/principle-rules/SKILL.md', description: '只按自由五子棋裁决：无禁手，长连也胜。' },
  'principle-evidence': { file: 'principles/principle-evidence/SKILL.md', description: '一步安全不等于战术安全；单线、标签、有界未发现都不是全局安全证明。' },
  'principle-tactics': { file: 'principles/principle-tactics/SKILL.md', description: '先取立即胜、再防立即输；自己的攻击计划必须接受对手连续先手反证。' },
  'principle-time': { file: 'principles/principle-time/SKILL.md', description: '网络与工具都计时；时间紧时缩短探索，不跳过合法性和即时威胁验证。' },
  'principle-commit': { file: 'principles/principle-commit/SKILL.md', description: '只提交当前 revision 的一子；验证在提交前完成，成功后回合结束。' },
  'opening': { file: 'playbooks/opening.md', description: '无即时胜负威胁且前八手：中央、联络、空间。' },
  'midgame': { file: 'playbooks/midgame.md', description: '常规中盘：提交前检查最终候选的对手连续冲四，先读反馈再决定。' },
  'endgame': { file: 'playbooks/endgame.md', description: '出现任一方即时成五点：战术收束，而非按手数判断终盘。' },
  'time-pressure': { file: 'playbooks/time-pressure.md', description: '临近丢失当前读秒或包干耗尽：压缩探索并及时提交。' },
  'evaluate-threats': { file: 'skills/evaluate-threats/SKILL.md', description: '解读即时获胜/必须应对点、启发式候选及其局限。' },
  'check-legality': { file: 'skills/check-legality/SKILL.md', description: '检查坐标、占用、终局与自由五子棋规则；不执行 Renju 禁手。' },
  'verify-board': { file: 'skills/verify-board/SKILL.md', description: '提交前只读检查候选与对手下一手成五点。' },
  'check-forcing-sequences': { file: 'skills/check-forcing-sequences/SKILL.md', description: '中盘依赖下一步进攻时，检查候选是否被对手连续冲四反证；有界未发现不保证安全。' },
} as const;
export type KnowledgeId = keyof typeof KNOWLEDGE_ITEMS;
export type PlaybookId = 'opening' | 'midgame' | 'endgame' | 'time-pressure';
export const PRINCIPLE_IDS = Object.keys(KNOWLEDGE_ITEMS).filter((id): id is KnowledgeId => id.startsWith('principle-'));
export const WORKFLOW_STEPS = ['observe', 'compare', 'verify', 'commit'] as const;
export interface SimulationEvidence {
  id: string;
  revision: number;
  candidate: string;
  moves: string[];
  winner: Position['winner'];
  nextImmediateWins: string[];
  nextOpponentImmediateWins: string[];
}
export interface ForcingEvidence {
  id: string;
  revision: number;
  candidate: string;
  source: 'explicit-tool' | 'pre-commit';
  result: ForcingCheck;
  returnedOnTurn: number;
  reviewedBeforeCommit: boolean;
  acknowledged: boolean;
}
export interface CandidateReview {
  version: 'candidate-review/v1';
  candidate: string;
  simulations: SimulationEvidence[];
  forcingChecks: ForcingEvidence[];
  finalCandidateSimulationIds: string[];
  finalCandidateCheckIds: string[];
  forcingReview: 'reviewed' | 'not-checked' | 'skipped-time-pressure' | 'not-required-immediate';
  coverage: 'single-line-only' | 'bounded-refutation' | 'incomplete-refutation' | 'not-compared';
}
export interface DecisionTrace {
  version: typeof KNOWLEDGE_VERSION | 'gomoku-knowledge/v1';
  revision: number;
  playbook: PlaybookId;
  knowledgeRead: KnowledgeId[];
  steps: Array<{ id: typeof WORKFLOW_STEPS[number]; status: 'done' | 'skipped'; evidence: string }>;
  validation: MoveValidation;
  // Optional for compatibility with historical records and non-Pi drivers.
  candidateReview?: CandidateReview;
}
export function positionSignals(position: Position, analysis: Analysis = analyze(position)) {
  return {
    ruleset: RULESET,
    facts: {
      source: 'all-empty-points-scan' as const,
      terminal: position.winner,
      next: position.next,
      immediateWins: analysis.winningMoves,
      opponentImmediateWins: analysis.mustBlock,
      unavoidableLossInOne: !position.winner && !analysis.winningMoves.length && analysis.mustBlock.length > 1,
    },
    priority: position.winner ? 'terminal' : analysis.winningMoves.length ? 'win-now' : analysis.mustBlock.length ? 'answer-immediate-threat' : 'develop',
    heuristics: {
      source: 'local-five-cell-windows' as const,
      candidates: analysis.candidates,
      limitations: ['分数不是胜率', '双三/双四为窗口棋形提示，不是强制获胜证明', '候选最多12个且局部剪枝；即时成五点不剪枝'],
    },
  };
}
export function turnGuidance(state: GameState, now: number) {
  const clock = structuredClone(state.clock);
  chargeClock(clock, state.match.settings, now);
  const player = clock.players[state.position.next];
  // Current-period loss is a planning signal, NOT a new authoritative deadline.
  const untilPeriodLossMs = state.match.settings.timeControl === 'absolute' ? player.mainMs : player.mainMs + player.periodMs;
  const untilForfeitMs = state.match.settings.timeControl === 'absolute' ? player.mainMs
    : player.mainMs + player.periodMs + Math.max(0, player.periodsLeft - 1) * state.match.settings.periodTimeMs;
  const signals = positionSignals(state.position);
  const urgent = untilPeriodLossMs <= 15_000;
  const playbook: PlaybookId | null = state.outcome || state.position.winner ? null : urgent ? 'time-pressure'
    : signals.priority !== 'develop' ? 'endgame' : state.position.moves.length < 8 ? 'opening' : 'midgame';
  return { version: KNOWLEDGE_VERSION, revision: state.revision, playbook, signals,
    time: { source: 'projected-snapshot' as const, asOf: now, untilPeriodLossMs, untilForfeitMs, periodsLeft: player.periodsLeft,
      urgent, warning: '时间只是快照建议；工具/网络也扣时，最终截止由业务层提交时裁决。' },
    steps: WORKFLOW_STEPS.map(id => ({ id, status: 'pending' as const })),
  };
}
export interface MoveValidation {
  legal: true;
  coordinate: string;
  winner: Position['winner'];
  opponentImmediateWinsAfter: Point[];
  warnings: string[];
  scope: 'one-ply-only';
}
export function validateCandidate(position: Position, point: Point): MoveValidation {
  const before = analyze(position), after = play(position, point), analysis = analyze(after);
  const warnings: string[] = [];
  if (before.winningMoves.length && after.winner !== position.next) warnings.push('放弃了本手直接获胜点');
  if (analysis.winningMoves.length) warnings.push('对手下一手仍可立即成五');
  return { legal: true, coordinate: coordinate(point), winner: after.winner,
    opponentImmediateWinsAfter: analysis.winningMoves, warnings, scope: 'one-ply-only' };
}
