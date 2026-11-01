import { boardText, colorName } from '../business/engine';
import { turnGuidance } from '../business/decision';
import { evaluationSummaries, turnSignals } from '../business/turn-context';
import type { GameState } from '../shared/types';
import { ANALYSIS_TURN_REQUESTS, MAX_TURN_REQUESTS } from './turn-budget';

export function turnPrompt(state: GameState): string {
  const p = state.position, guidance = turnGuidance(state);
  return `现在轮到你，执${colorName(p.next)}。revision=${state.revision}。
${guidance ? `业务建议剧本：${guidance.playbook}；依据：${guidance.evidence}。按技能索引用 read 读取对应 SKILL.md；此处仅提供建议，不代表已加载全文。` : ''}
回合开始时你的剩余棋钟：${Math.floor(state.clock.players[p.next].mainMs / 1000)} 秒；${state.match.settings.timeControl === 'fischer' ? `及时合法落子后加 ${state.match.settings.incrementMs / 1000} 秒` : '包干制，不加秒'}。不另设单步时间上限；网络、思考和工具计算都扣当前方棋钟，必须在余时耗尽前完成落子或主动认输（resign_game，携带当前 revision 与简短理由）；不能用送子或等待超时代替认输。
单回合最多 ${MAX_TURN_REQUESTS} 次模型请求（读取技能/引用后的续问也计数）。前 ${ANALYSIS_TURN_REQUESTS} 次完成必要读取、比较与计划；第 ${ANALYSIS_TURN_REQUESTS + 1}–${MAX_TURN_REQUESTS} 次仅提供 move_piece / resign_game，必须提交，最后一次可纠正审查错误。不要把最后请求花在计划、复述或继续读取上。
完整棋谱（业务坐标不随桌面翻转改变）：
${p.moves.map((m, i) => `${i + 1}. ${m.notation}`).join('\n') || '初始阵型'}
${boardText(p)}
业务层逐手摘要（最近20手及吃子手）：${JSON.stringify(evaluationSummaries(state))}
最近机器公开理由（历史数据，须重验）：${JSON.stringify(state.notes.slice(-2).map(n => ({ ply: n.ply, reason: n.reason })))}
signals（完整报告按需 analyze_position）：${JSON.stringify(turnSignals(state))}`;
}
