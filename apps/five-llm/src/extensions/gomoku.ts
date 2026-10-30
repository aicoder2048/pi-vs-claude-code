import { Type } from '@earendil-works/pi-ai';
import { defineTool, isToolCallEventType, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { analyze, boardText, coordinate, play, replay } from '../business/engine';
import { KNOWLEDGE_ITEMS, KNOWLEDGE_VERSION, positionSignals, turnGuidance, validateCandidate,
  type DecisionTrace, type KnowledgeId, type PlaybookId } from '../business/decision';
import { readKnowledge } from '../agent/knowledge-loader';
import type { TurnPort } from '../business/game-service';

export const GAME_TOOLS = ['analyze_position', 'evaluate_threats', 'validate_move', 'read_knowledge', 'simulate_moves', 'place_stone'];
const pointSchema = { x: Type.Integer({ minimum: 0, maximum: 14, description: 'Column: A=0 through O=14' }),
  y: Type.Integer({ minimum: 0, maximum: 14, description: 'Row index: top row 15=0, bottom row 1=14' }) };
const revisionSchema = Type.Integer({ minimum: 0 });
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value });

// Only this turn's domain port can commit; knowledge reads have no filesystem
// capability beyond the host-owned ID whitelist. All tools register at load.
export function gomokuExtension(port: TurnPort, selectedPlaybook?: PlaybookId): ExtensionFactory {
  return pi => {
    const playbook = selectedPlaybook ?? turnGuidance(port.state, Date.now()).playbook;
    if (!playbook) throw new Error('棋局已经结束');
    let calls = 0, observed = '', simulated = '', committed = false;
    const knowledgeRead: KnowledgeId[] = ['gomoku-coach', playbook];
    const ensureActive = () => {
      if (port.signal.aborted) throw new Error('本回合已取消');
      if (committed) throw new Error('本回合已经落子');
    };
    const checkRevision = (revision: number) => {
      if (revision !== port.state.revision) throw new Error(`版本错误：当前 revision=${port.state.revision}`);
    };
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
      description: 'Replay the complete game record and return the board, analysis and structured decision signals. Counts as observe evidence. Scores are heuristics, not win probabilities.',
      parameters: Type.Object({}), executionMode: 'sequential',
      async execute() {
        ensureActive();
        const position = replay(port.state.position.moves), analysis = analyze(position);
        observed = `analyze_position revision=${port.state.revision}`;
        return result({ revision: port.state.revision, board: boardText(position), analysis, signals: positionSignals(position, analysis) });
      },
    }));
    pi.registerTool(defineTool({
      name: 'evaluate_threats', label: '威胁信号',
      description: 'Observe structured facts (all immediate wins and opponent wins), heuristic candidates and projected time guidance. Use at least this tool OR analyze_position before committing.',
      parameters: Type.Object({}), executionMode: 'sequential',
      async execute() {
        ensureActive();
        const guidance = turnGuidance(port.state, Date.now());
        observed = `evaluate_threats revision=${port.state.revision}`;
        return result(guidance);
      },
    }));
    pi.registerTool(defineTool({
      name: 'read_knowledge', label: '领域知识',
      description: 'Read a built-in principle, playbook or skill by indexed ID, never by file path. Read only relevant entries; each call uses the tool budget.',
      parameters: Type.Object({ id: Type.Union((Object.keys(KNOWLEDGE_ITEMS) as KnowledgeId[]).map(id => Type.Literal(id))) }),
      executionMode: 'sequential',
      async execute(_id, params) {
        ensureActive();
        const text = readKnowledge(params.id);
        if (!knowledgeRead.includes(params.id)) knowledgeRead.push(params.id);
        return result({ version: KNOWLEDGE_VERSION, id: params.id, text });
      },
    }));
    pi.registerTool(defineTool({
      name: 'validate_move', label: '候选验证',
      description: 'Read-only pre-commit validation of one candidate: legality, winner, missed immediate win and opponent immediate wins after it. No Renju bans. Warnings are advisory, not a veto or proof of long-term safety.',
      parameters: Type.Object({ ...pointSchema, revision: revisionSchema }), executionMode: 'sequential',
      async execute(_id, params) {
        ensureActive(); checkRevision(params.revision);
        return result({ revision: port.state.revision, validation: validateCandidate(replay(port.state.position.moves), params) });
      },
    }));
    pi.registerTool(defineTool({
      name: 'simulate_moves', label: '变化试算',
      description: 'Try 1–6 alternating hypothetical moves on a copied board. This single line is not exhaustive or a forced-win proof. It does not replace observing the CURRENT position before committing.',
      parameters: Type.Object({ moves: Type.Array(Type.Object(pointSchema), { minItems: 1, maxItems: 6 }) }),
      executionMode: 'sequential',
      async execute(_id, params) {
        ensureActive();
        let position = replay(port.state.position.moves);
        for (const point of params.moves) position = play(position, point);
        simulated = `simulate_moves ${params.moves.map(coordinate).join(' → ')}`;
        const analysis = analyze(position);
        return result({ revision: port.state.revision, hypothetical: true, board: boardText(position), winner: position.winner, analysis, signals: positionSignals(position, analysis) });
      },
    }));
    pi.registerTool(defineTool({
      name: 'place_stone', label: '落子',
      description: 'Commit ONE legal move with current revision and concise public Chinese reason. Requires analyze_position OR evaluate_threats first. Automatically validates candidate and records evidence; strategy warnings do not veto legal moves. Successful commit ends the run, so do not verify afterward.',
      parameters: Type.Object({ ...pointSchema, revision: revisionSchema, reason: Type.String({ minLength: 1, maxLength: 600 }) }),
      executionMode: 'sequential',
      async execute(_id, params) {
        ensureActive(); checkRevision(params.revision);
        if (!observed) throw new Error('请先调用 analyze_position 或 evaluate_threats 获取当前局面证据');
        const validation = validateCandidate(replay(port.state.position.moves), params);
        const trace: DecisionTrace = { version: KNOWLEDGE_VERSION, revision: port.state.revision, playbook, knowledgeRead: [...knowledgeRead], validation,
          steps: [
            { id: 'observe', status: 'done', evidence: observed },
            { id: 'compare', status: simulated ? 'done' : 'skipped', evidence: simulated || (playbook === 'time-pressure'
              ? '时间紧迫：未调用变化试算，保留即时扫描和提交前验证' : '未调用可选变化试算；不将候选排名视为深层证明') },
            { id: 'verify', status: 'done', evidence: 'place_stone 自动合法性与对手一手成五扫描；scope=one-ply-only' },
            { id: 'commit', status: 'done', evidence: `${coordinate(params)} revision=${params.revision}` },
          ] };
        // GameService still owns clock, revision, turn and duplicate checks.
        port.commit(params, params.reason, trace);
        committed = true;
        return { ...result({ accepted: true, coordinate: coordinate(params), validation }), terminate: true };
      },
    }));
  };
}
