import { Type } from '@earendil-works/pi-ai';
import { defineTool, isToolCallEventType, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { boardText, moveText, play, replay } from '../business/engine';
import { analyzeExpert, compareMoves, reviewMove } from '../business/expert';
import { retrieveKnowledge } from '../business/knowledge';
import type { TurnPort } from '../business/game-service';
const point = Type.Object({ x: Type.Integer({ minimum: 0, maximum: 8 }), y: Type.Integer({ minimum: 0, maximum: 9 }) });
const move = { from: point, to: point };
export const XIANGQI_TOOLS = ['analyze_position', 'review_move', 'compare_moves', 'simulate_moves', 'move_piece'];
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value });
export function xiangqiExtension(port: TurnPort): ExtensionFactory {
  return pi => {
    let calls = 0, committed = false;
    const active = () => { if (port.signal.aborted || committed) throw new Error('本回合已结束或取消'); };
    pi.on('tool_call', event => {
      active();
      if (++calls > 16) return { block: true, reason: '单回合工具调用预算已耗尽' };
      if (isToolCallEventType<'move_piece', { from: { x: number; y: number }; to: { x: number; y: number }; revision: number; reason: string }>('move_piece', event)) {
        port.log('extension', `校验走子：${moveText(event.input)} · revision ${event.input.revision}`);
      } else port.log('extension', `工具调用：${event.toolName}`);
      return undefined;
    });
    pi.registerTool(defineTool({
      name: 'analyze_position', label: '象棋局势计算', executionMode: 'sequential',
      description: 'Return the authoritative board, ALL legal moves and business expert report: legal attackers vs geometric defenders, pinned/loose pieces, phase-specific principles and candidate counter-replies. Read coverage/limitations; estimates are not proofs or win probabilities.',
      parameters: Type.Object({}),
      async execute() { active(); return result({ revision: port.state.revision, board: boardText(port.state.position), analysis: port.state.analysis.expert ? port.state.analysis : analyzeExpert(port.state.position) }); },
    }));
    pi.registerTool(defineTool({
      name: 'review_move', label: '专家走法审查', executionMode: 'sequential',
      description: 'Review ONE legal candidate without committing. Business layer enumerates opponent replies, checks immediate mate/stalemate and bounded legal recapture exchanges. Returns counterexample line, estimated net material, coverage and warnings. Off-square sacrifices require further simulation.',
      parameters: Type.Object(move),
      async execute(_id, params) { active(); const review = reviewMove(port.state.position, params); return result({ revision: port.state.revision, review, experiences: port.recall?.(port.state.position, [review]) ?? [] }); },
    }));
    pi.registerTool(defineTool({
      name: 'compare_moves', label: '专家候选比较', executionMode: 'sequential',
      description: 'Compare 1–6 candidate moves using opponent counter-replies, not cooperative variations invented by the model. Equal bounded budgets. Unknown coverage is not safety; scores are advisory. No move is committed.',
      parameters: Type.Object({ moves: Type.Array(Type.Object(move), { minItems: 1, maxItems: 6 }) }),
      async execute(_id, params) { active(); const reviews = compareMoves(port.state.position, params.moves); return result({ revision: port.state.revision, reviews, experiences: port.recall?.(port.state.position, reviews) ?? [] }); },
    }));
    pi.registerTool(defineTool({
      name: 'simulate_moves', label: '变化试算', executionMode: 'sequential',
      description: 'Try 1–6 alternating legal Xiangqi moves on a copy. Does not commit. Correct errors and retry.',
      parameters: Type.Object({ moves: Type.Array(Type.Object(move), { minItems: 1, maxItems: 6 }) }),
      async execute(_id, params) {
        active(); let p = replay(port.state.position.moves);
        for (const m of params.moves) p = play(p, m);
        const analysis = analyzeExpert(p, { candidateLimit: 6, maxMs: 40, maxNodes: 2500 });
        if (analysis.expert) { analysis.expert.knowledge = retrieveKnowledge(p, analysis.expert); analysis.expert.experiences = port.recall?.(p, analysis.expert.candidates) ?? []; }
        return result({ board: boardText(p), winner: p.winner, endReason: p.endReason, analysis });
      },
    }));
    pi.registerTool(defineTool({
      name: 'move_piece', label: '移动棋子', executionMode: 'sequential',
      description: 'Commit ONE legal move. The business layer ALWAYS re-reviews it. A direct losing reply or estimated material loss >=250 requires correction or riskAcknowledgement (12–400 Chinese characters explaining concrete sacrifice compensation or unavoidable loss). Do not add acknowledgement routinely to bypass review. Coordinates A..I=0..8, black home y=0, red home y=9. Correct revision required. Success ends turn.',
      parameters: Type.Object({ ...move, revision: Type.Integer({ minimum: 0 }), reason: Type.String({ minLength: 1, maxLength: 600 }),
        riskAcknowledgement: Type.Optional(Type.String({ minLength: 12, maxLength: 400, description: 'Only if deliberately accepting a reported risk; explain concrete compensation or unavoidable loss, not generic attacking slogans.' })) }),
      async execute(_id, params) {
        active();
        if (params.revision !== port.state.revision) throw new Error(`版本错误：当前 revision=${port.state.revision}`);
        port.commit(params, params.reason, params.riskAcknowledgement); committed = true;
        return { ...result({ accepted: true, move: moveText(params) }), terminate: true };
      },
    }));
  };
}
