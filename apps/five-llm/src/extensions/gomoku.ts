import { Type } from '@earendil-works/pi-ai';
import { defineTool, isToolCallEventType, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { analyze, boardText, coordinate, play, replay } from '../business/engine';
import { KNOWLEDGE_ITEMS, KNOWLEDGE_VERSION, positionSignals, turnGuidance, validateCandidate,
  type DecisionTrace, type KnowledgeId, type PlaybookId, type ForcingEvidence, type OwnWinEvidence, type SimulationEvidence } from '../business/decision';
import { checkForcingSequences, findOwnForcingWin, DEFAULT_FORCING_BUDGET, type ForcingBudget } from '../business/forcing';
import type { Point } from '../business/rules';
import { readKnowledge } from '../agent/knowledge-loader';
import type { TurnPort } from '../business/game-service';

export const GAME_TOOLS = ['analyze_position', 'evaluate_threats', 'validate_move', 'read_knowledge', 'simulate_moves', 'check_forcing_sequences', 'find_forcing_win', 'place_stone'];
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
    let calls = 0, observed = '', committed = false, modelTurn = 0;
    const simulations: SimulationEvidence[] = [], forcingChecks: ForcingEvidence[] = [], ownWinChecks: OwnWinEvidence[] = [];
    const knowledgeRead: KnowledgeId[] = ['gomoku-coach', playbook];
    pi.on('turn_start', () => { modelTurn++; });
    const ensureActive = () => {
      if (port.signal.aborted) throw new Error('本回合已取消');
      if (committed) throw new Error('本回合已经落子');
    };
    const checkRevision = (revision: number) => {
      if (revision !== port.state.revision) throw new Error(`版本错误：当前 revision=${port.state.revision}`);
    };
    const ownWinCheck = () => ownWinChecks.find(c => c.result.status === 'found-forced-win') ?? ownWinChecks.at(-1);
    const searchOwnWin = async (source: OwnWinEvidence['source'], requested: Partial<ForcingBudget> = {}) => {
      const guidance = turnGuidance(port.state, Date.now());
      const outcome = await findOwnForcingWin(replay(port.state.position.moves), {
        maxAttackMoves: requested.maxAttackMoves ?? DEFAULT_FORCING_BUDGET.maxAttackMoves,
        maxNodes: Math.min(requested.maxNodes ?? DEFAULT_FORCING_BUDGET.maxNodes, DEFAULT_FORCING_BUDGET.maxNodes),
        maxMs: guidance.time.urgent ? 0 : Math.max(0, Math.min(requested.maxMs ?? DEFAULT_FORCING_BUDGET.maxMs,
          DEFAULT_FORCING_BUDGET.maxMs, Math.floor(guidance.time.untilPeriodLossMs - 2000))),
        signal: port.signal,
      });
      ensureActive();
      if (guidance.time.urgent && outcome.status === 'incomplete' && outcome.reason === 'time-budget') outcome.reason = 'clock-budget';
      const evidence: OwnWinEvidence = { id: `own-win-${ownWinChecks.length + 1}`, revision: port.state.revision,
        source, result: outcome, returnedOnTurn: modelTurn, reviewedBeforeCommit: false };
      ownWinChecks.push(evidence);
      return evidence;
    };
    const hasAutomaticOwnSearch = () => ownWinChecks.some(c => c.source !== 'explicit-tool' || c.result.status === 'found-forced-win');
    const observeOwnWin = async () => {
      const guidance = turnGuidance(port.state, Date.now());
      if (!hasAutomaticOwnSearch() && port.state.position.moves.length >= 8
        && guidance.signals.priority === 'develop' && !guidance.time.urgent) await searchOwnWin('observe');
      return ownWinCheck();
    };
    const ownWinReply = (check: OwnWinEvidence, candidate: string) => result({ accepted: false, needsReview: true,
      reason: candidate === check.result.winningCandidate ? 'unread-forced-win' : 'missed-forced-win', candidate, ownWinCheck: check,
      instruction: '尚未落子。发现己方可验证的连续冲四胜法，先读 proof.line 和 winningPoints，下一次模型请求再决定。可选择证明起手；若坚持其他合法落点，显式 acknowledgeMissedWin:true。不是自动代下；未发现胜法不代表没有胜法。' });
    const reviewCandidate = async (point: Point, source: ForcingEvidence['source'], requested: Partial<ForcingBudget> = {}) => {
      const guidance = turnGuidance(port.state, Date.now());
      const budget: ForcingBudget = {
        maxAttackMoves: requested.maxAttackMoves ?? DEFAULT_FORCING_BUDGET.maxAttackMoves,
        maxNodes: Math.min(requested.maxNodes ?? DEFAULT_FORCING_BUDGET.maxNodes, DEFAULT_FORCING_BUDGET.maxNodes),
        maxMs: Math.max(0, Math.min(requested.maxMs ?? DEFAULT_FORCING_BUDGET.maxMs, DEFAULT_FORCING_BUDGET.maxMs, Math.floor(guidance.time.untilPeriodLossMs - 2000))),
      };
      const result = await checkForcingSequences(replay(port.state.position.moves), point, {
        ...budget, ...(guidance.time.urgent ? { maxMs: 0 } : {}), signal: port.signal,
      });
      ensureActive();
      if (guidance.time.urgent && result.status === 'incomplete' && result.reason === 'time-budget') result.reason = 'clock-budget';
      const evidence: ForcingEvidence = { id: `forcing-${forcingChecks.length + 1}`, revision: port.state.revision,
        candidate: coordinate(point), source, result, returnedOnTurn: modelTurn, reviewedBeforeCommit: false, acknowledged: false };
      forcingChecks.push(evidence);
      return evidence;
    };
    const reviewReply = (check: ForcingEvidence) => result({ accepted: false, needsReview: true, check,
      instruction: '尚未落子。先阅读候选反证；可改选并检查另一候选。若仍选此子，下一次模型请求再提交；败势或检查未完成须 acknowledgeRisk:true。预算内未发现不代表安全。' });
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
        const ownForcingWin = await observeOwnWin();
        return result({ revision: port.state.revision, board: boardText(position), analysis, signals: positionSignals(position, analysis), ownForcingWin });
      },
    }));
    pi.registerTool(defineTool({
      name: 'evaluate_threats', label: '威胁信号',
      description: 'Observe immediate wins, opponent wins, heuristics and time guidance. Automatically searches OWN continuous-four wins in non-urgent midgame, returning proof evidence in ownForcingWin. Read proven wins before choosing a defensive heuristic. Use this OR analyze_position before committing.',
      parameters: Type.Object({}), executionMode: 'sequential',
      async execute() {
        ensureActive();
        const guidance = turnGuidance(port.state, Date.now());
        observed = `evaluate_threats revision=${port.state.revision}`;
        const ownForcingWin = await observeOwnWin();
        return result({ ...guidance, ownForcingWin });
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
      name: 'check_forcing_sequences', label: '连续先手反证',
      description: 'Read-only PRE-COMMIT candidate refutation. Check whether the opponent can force a win by continuous fours; never selects a move. Returns found-forced-loss, not-found-within-budget (NOT safe), or incomplete. Read the result on a later model turn before committing a midgame candidate. Clock/node/time caps apply.',
      parameters: Type.Object({ ...pointSchema, revision: revisionSchema,
        maxAttackMoves: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
        maxNodes: Type.Optional(Type.Integer({ minimum: 0, maximum: 6000 })),
        maxMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 200 })),
      }), executionMode: 'sequential',
      async execute(_id, params) {
        ensureActive(); checkRevision(params.revision);
        const check = await reviewCandidate(params, 'explicit-tool', params);
        return result({ revision: port.state.revision, check,
          limitation: '仅检查对手连续冲四；未发现或未完成都不是安全证明。不是推荐落子。' });
      },
    }));
    pi.registerTool(defineTool({
      name: 'find_forcing_win', label: '己方强杀发现',
      description: 'Read-only search for the CURRENT player\'s own continuous-four forced win, across all forcing starts (not heuristic top-N). Returns found-forced-win with winningCandidate and proof, not-found-within-budget (NOT no win), or incomplete. Does not observe or commit. Review evidence on a later model turn. Clock/node/time caps apply.',
      parameters: Type.Object({ revision: revisionSchema,
        maxAttackMoves: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
        maxNodes: Type.Optional(Type.Integer({ minimum: 0, maximum: 6000 })),
        maxMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 200 })),
      }), executionMode: 'sequential',
      async execute(_id, params) {
        ensureActive(); checkRevision(params.revision);
        const check = await searchOwnWin('explicit-tool', params);
        return result({ revision: port.state.revision, ownForcingWin: check,
          limitation: '只证明己方连续冲四胜法，不是全局最优落点；未找到或未完成都不代表没有胜法。' });
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
        const analysis = analyze(position);
        const simulation: SimulationEvidence = { id: `simulation-${simulations.length + 1}`, revision: port.state.revision,
          candidate: coordinate(params.moves[0]), moves: params.moves.map(coordinate), winner: position.winner,
          nextImmediateWins: analysis.winningMoves.map(coordinate), nextOpponentImmediateWins: analysis.mustBlock.map(coordinate) };
        simulations.push(simulation);
        return result({ revision: port.state.revision, simulationId: simulation.id, hypothetical: true, board: boardText(position), winner: position.winner, analysis, signals: positionSignals(position, analysis) });
      },
    }));
    pi.registerTool(defineTool({
      name: 'place_stone', label: '落子',
      description: 'Commit ONE legal move after observing. A proven OWN forcing win must be read on an EARLIER model turn; choosing another move requires acknowledgeMissedWin:true. Otherwise normal midgame requires prior opponent forcing-check feedback; found losses/incomplete checks require acknowledgeRisk:true. Missing review returns accepted:false/needsReview WITHOUT placing. Immediate tactics and urgent clock bypass extra review. Never auto-replaces a move; accepted:true ends the run.',
      parameters: Type.Object({ ...pointSchema, revision: revisionSchema, reason: Type.String({ minLength: 1, maxLength: 600 }),
        acknowledgeRisk: Type.Optional(Type.Boolean({ description: 'Explicitly keep this candidate despite a previously returned forced-loss or incomplete check. Does not waive clock or legality.' })),
        acknowledgeMissedWin: Type.Optional(Type.Boolean({ description: 'After reading a proven own forcing win on an earlier model turn, explicitly choose a different candidate. Separate from acknowledgeRisk; never waives legality or clock.' })),
      }),
      executionMode: 'sequential',
      async execute(_id, params) {
        ensureActive(); checkRevision(params.revision);
        if (!observed) throw new Error('请先调用 analyze_position 或 evaluate_threats 获取当前局面证据');
        const position = replay(port.state.position.moves), validation = validateCandidate(position, params);
        const guidance = turnGuidance(port.state, Date.now()), candidate = coordinate(params);
        const immediate = guidance.signals.priority !== 'develop';
        const needsReview = position.moves.length >= 8 && !immediate && !guidance.time.urgent;
        if (needsReview && !hasAutomaticOwnSearch()) await searchOwnWin('pre-commit');
        const own = ownWinCheck();
        const provenOwnWin = own?.result.status === 'found-forced-win';
        if (!immediate && !guidance.time.urgent && provenOwnWin
          && (own.returnedOnTurn >= modelTurn || (candidate !== own.result.winningCandidate && !params.acknowledgeMissedWin))) {
          return ownWinReply(own, candidate);
        }
        const selectsProvenWin = provenOwnWin && own.returnedOnTurn < modelTurn && candidate === own.result.winningCandidate;
        // A shallower negative re-check cannot erase a previously proven refutation.
        let check = forcingChecks.findLast(c => c.candidate === candidate && c.result.status === 'found-forced-loss')
          ?? forcingChecks.findLast(c => c.candidate === candidate);
        if (needsReview && !selectsProvenWin) {
          if (!check) { check = await reviewCandidate(params, 'pre-commit'); return reviewReply(check); }
          if (check.returnedOnTurn >= modelTurn || (check.result.status !== 'not-found-within-budget' && !params.acknowledgeRisk)) return reviewReply(check);
        }
        for (const evidence of ownWinChecks) evidence.reviewedBeforeCommit = evidence.returnedOnTurn < modelTurn;
        for (const evidence of forcingChecks) evidence.reviewedBeforeCommit = evidence.returnedOnTurn < modelTurn;
        if (check?.reviewedBeforeCommit) check.acknowledged = !!params.acknowledgeRisk && check.result.status !== 'not-found-within-budget';
        const finalSimulations = simulations.filter(s => s.candidate === candidate);
        const reviewed = check?.reviewedBeforeCommit === true;
        const completeReview = reviewed && check!.result.status !== 'incomplete';
        const compared = finalSimulations.length > 0 || completeReview || selectsProvenWin;
        const comparison = [
          ...finalSimulations.map(s => `simulate_moves ${s.moves.join(' → ')} (${s.id}; 单线探索)`),
          ...(reviewed ? [`${check!.id}: ${check!.result.status}; 仅连续冲四反证，不是全局安全证明`] : []),
          ...(selectsProvenWin ? [`${own!.id}: 己方连续冲四强杀证明 ${own!.result.proof!.line.map(coordinate).join(' → ')}`] : []),
        ].join('; ');
        const trace: DecisionTrace = { version: KNOWLEDGE_VERSION, revision: port.state.revision, playbook, knowledgeRead: [...knowledgeRead], validation,
          candidateReview: { version: 'candidate-review/v1', candidate,
            simulations: structuredClone(simulations), forcingChecks: structuredClone(forcingChecks), ownWinChecks: structuredClone(ownWinChecks),
            ownWinReview: own?.reviewedBeforeCommit ? 'reviewed' : guidance.time.urgent ? 'skipped-time-pressure' : immediate ? 'not-required-immediate' : 'not-checked',
            declinedProvenWin: !!(provenOwnWin && own.reviewedBeforeCommit && candidate !== own.result.winningCandidate && params.acknowledgeMissedWin),
            finalCandidateSimulationIds: finalSimulations.map(s => s.id),
            finalCandidateCheckIds: forcingChecks.filter(c => c.candidate === candidate).map(c => c.id),
            forcingReview: reviewed ? 'reviewed' : immediate ? 'not-required-immediate' : guidance.time.urgent ? 'skipped-time-pressure' : 'not-checked',
            coverage: selectsProvenWin ? 'own-forcing-proof' : reviewed ? completeReview ? 'bounded-refutation' : 'incomplete-refutation' : finalSimulations.length ? 'single-line-only' : 'not-compared' },
          steps: [
            { id: 'observe', status: 'done', evidence: observed },
            { id: 'compare', status: compared ? 'done' : 'skipped', evidence: comparison || (guidance.time.urgent
              ? '时间紧迫：最终候选未完成连续先手审查，保留即时扫描和提交前验证'
              : `最终候选未比较；其他候选试算 ${simulations.length} 条，不将候选排名或单线视为深层证明`) },
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
