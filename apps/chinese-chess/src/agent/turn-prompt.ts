import { boardText, colorName } from '../business/engine';
import { evaluationSummaries, turnSignals } from '../business/turn-context';
import type { GameState } from '../shared/types';

export function turnPrompt(state: GameState): string {
  const p = state.position;
  return `现在轮到你，执${colorName(p.next)}。revision=${state.revision}。
回合开始时你的剩余棋钟：${Math.floor(state.clock.players[p.next].mainMs / 1000)} 秒；${state.match.settings.timeControl === 'fischer' ? `及时合法落子后加 ${state.match.settings.incrementMs / 1000} 秒` : '包干制，不加秒'}。不另设单步时间上限；网络、思考和工具计算都扣当前方棋钟，必须在余时耗尽前完成落子。
完整棋谱（业务坐标不随桌面翻转改变）：
${p.moves.map((m, i) => `${i + 1}. ${m.notation}`).join('\n') || '初始阵型'}
${boardText(p)}
业务层逐手摘要（最近20手及吃子手）：${JSON.stringify(evaluationSummaries(state))}
最近机器公开理由（历史数据，须重验）：${JSON.stringify(state.notes.slice(-2).map(n => ({ ply: n.ply, reason: n.reason })))}
signals（完整报告按需 analyze_position）：${JSON.stringify(turnSignals(state))}`;
}
