import { Type } from '@earendil-works/pi-ai';
import { defineTool, isToolCallEventType, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { analyze, boardText, coordinate, play, replay } from '../business/engine';
import type { TurnPort } from '../business/game-service';

const pointSchema = { x: Type.Integer({ minimum: 0, maximum: 14, description: 'Column: A=0 through O=14' }),
  y: Type.Integer({ minimum: 0, maximum: 14, description: 'Row index: top row 15=0, bottom row 1=14' }) };
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value });

// Inject a turn-scoped domain port, not a global board. Even sibling/late tool
// calls cannot mutate any other turn. Loaded by the SDK as an inline Pi extension.
export function gomokuExtension(port: TurnPort): ExtensionFactory {
  return pi => {
    let calls = 0;
    const ensureActive = () => { if (port.signal.aborted) throw new Error('本回合已取消'); };
    pi.on('tool_call', event => {
      ensureActive();
      if (++calls > 16) return { block: true, reason: '单回合工具调用预算已耗尽' };
      if (isToolCallEventType<'place_stone', { x: number; y: number; revision: number; reason: string }>('place_stone', event)) {
        port.log('extension', `校验落子请求：${coordinate(event.input)} · revision ${event.input.revision}`);
      } else port.log('extension', `工具调用：${event.toolName}`);
      return undefined;
    });
    pi.registerTool(defineTool({
      name: 'analyze_position', label: '局势计算',
      description: 'Replay the complete game record and calculate legal position, immediate wins, mandatory blocks, and ranked tactical candidates. Scores are heuristics, not win probabilities.',
      parameters: Type.Object({}),
      executionMode: 'sequential',
      async execute() {
        ensureActive();
        const position = replay(port.state.position.moves);
        return result({ revision: port.state.revision, board: boardText(position), analysis: analyze(position) });
      },
    }));
    pi.registerTool(defineTool({
      name: 'simulate_moves', label: '变化试算',
      description: 'Try 1–6 alternating hypothetical moves starting with your color on a copied board. Returns calculated position without committing. Invalid sequences return a tool error; correct and retry.',
      parameters: Type.Object({ moves: Type.Array(Type.Object(pointSchema), { minItems: 1, maxItems: 6 }) }),
      executionMode: 'sequential',
      async execute(_id, params) {
        ensureActive();
        let position = replay(port.state.position.moves);
        for (const point of params.moves) position = play(position, point);
        return result({ board: boardText(position), winner: position.winner, analysis: analyze(position) });
      },
    }));
    pi.registerTool(defineTool({
      name: 'place_stone', label: '落子',
      description: 'Commit exactly ONE legal move for your turn. Copy the revision from the current position. Supply a concise public Chinese reason, not private chain-of-thought. A successful commit ends the run; an illegal move is rejected for correction.',
      parameters: Type.Object({ ...pointSchema, revision: Type.Integer({ minimum: 0 }), reason: Type.String({ minLength: 1, maxLength: 600 }) }),
      executionMode: 'sequential',
      async execute(_id, params) {
        ensureActive();
        if (params.revision !== port.state.revision) throw new Error(`版本错误：当前 revision=${port.state.revision}`);
        port.commit(params, params.reason);
        return { ...result({ accepted: true, coordinate: coordinate(params) }), terminate: true };
      },
    }));
  };
}
