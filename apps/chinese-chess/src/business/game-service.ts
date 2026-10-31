import { randomUUID } from 'node:crypto';
import { emptyPosition, other, play, replay, type Analysis, type Color, type MoveInput, type Position } from './engine';
import { chargeClock, DEFAULT_SETTINGS, newClock, switchClock, validateSettings } from './clock';
import { analyzeExpert, MoveRiskError, needsRiskAcknowledgement, reviewMove } from './expert';
import { recallExperience, type TacticalCase } from './learning';
import { retrieveKnowledge } from './knowledge';
import { searchPosition, type SearchDriver, type SearchOptions, type SearchReport } from './search';
import { FINAL_SEARCH_MS, liveSearchOptions, mergeSearchReview, TURN_SEARCH_MS, TURN_SEARCH_NODES } from './live-search';
import { planForPosition, updatePlan, type PlanUpdate, type StrategicPlan } from './plan';
import { REASON_TEXT } from '../shared/types';
import { recordDecisionTool, SKILLS_VERSION, type DecisionTrace } from './decision';
import { TurnTimer, type AttemptStatus, type TimingEvent } from './turn-timing';
import type { GameRecord, GameState, LogEntry, MatchSettings, MatchState, ModelChoice, ResultReason } from '../shared/types';

// Dependency inversion: the domain knows this port, not Pi's implementation.
export interface TurnPort {
  state: GameState;
  signal: AbortSignal;
  recall?(position: Position, reviews?: import('./expert').MoveReview[]): import('./learning').ExperienceHint[];
  log(layer: LogEntry['layer'], text: string): void;
  search?(options?: SearchOptions, signal?: AbortSignal): Promise<SearchReport>;
  updatePlan?(input: PlanUpdate): StrategicPlan | null;
  setDecision?(trace: DecisionTrace): void;
  telemetry?(event: TimingEvent): void;
  commit(point: MoveInput, reason: string, riskAcknowledgement?: string, signal?: AbortSignal): Promise<void> | void;
}
export interface AgentDriver { run(port: TurnPort): Promise<void> }
export interface ServiceOptions { now?: () => number; settings?: MatchSettings; cases?: () => readonly TacticalCase[]; search?: SearchDriver }
export class GameService {
  private state: GameState;
  private active?: AbortController;
  private turnTimer?: TurnTimer;
  private stopAttempt?: (status: AttemptStatus) => void;
  private updateSequence = 0;
  private listeners = new Set<(state: GameState) => void>();
  private readonly now: () => number;
  private readonly cases: () => readonly TacticalCase[];
  private readonly searchDriver: SearchDriver;
  constructor(private driver: AgentDriver, model: ModelChoice | null = null, options: ServiceOptions = {}) {
    this.cases = options.cases ?? (() => []);
    // Desktop injects a Worker driver. The pure in-process fallback is useful
    // for embedding/tests; it observes the same cooperative bounds.
    this.searchDriver = options.search ?? { async search(p, opts, signal) { return searchPosition(p, { ...opts, signal }); } };
    this.now = options.now ?? (() => performance.timeOrigin + performance.now());
    this.state = this.fresh(1, model, this.newMatch(options.settings ?? DEFAULT_SETTINGS));
  }
  private analyze(position: Position) {
    const analysis = analyzeExpert(position);
    if (analysis.expert) {
      analysis.expert.knowledge = retrieveKnowledge(position, analysis.expert);
      analysis.expert.experiences = recallExperience(position, analysis.expert, this.cases());
    }
    return analysis;
  }
  refreshExperience(): void {
    const e = this.state.analysis.expert;
    if (e) e.experiences = recallExperience(this.state.position, e, this.cases());
    this.emit();
  }
  private newMatch(settings: MatchSettings): MatchState {
    return { id: randomUUID(), settings: validateSettings(settings), humanWins: 0, machineWins: 0, draws: 0, rounds: [], winner: null };
  }
  private fresh(human: Color, model: ModelChoice | null, match: MatchState): GameState {
    const position = emptyPosition();
    return { id: randomUUID(), revision: this.state ? this.state.revision + 1 : 0, human, model, match, outcome: null,
      clock: newClock(match.settings, this.now()), position, analysis: this.analyze(position), evaluations: [], notes: [], plan: null,
      status: human === 1 ? 'human' : 'paused', error: null, logs: [] };
  }
  snapshot(): GameState { return structuredClone(this.state); }
  // What subscribers and command replies get. Per-ply evaluations grow to MBs
  // over a long game and the 5 Hz heartbeat would clone them every tick, so
  // they are left out; read one with evaluation(ply) when reviewing history.
  view(): GameState { return structuredClone({ ...this.state, evaluations: [], attempts: this.state.attempts?.slice(-1) }); }
  evaluation(gameId: string, ply: number): Analysis | null {
    if (gameId !== this.state.id || !Number.isSafeInteger(ply) || ply < 1) return null;
    return structuredClone(this.state.evaluations[ply - 1] ?? null);
  }
  subscribe(fn: (state: GameState) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(): void {
    this.state.updateSequence = ++this.updateSequence;
    for (const fn of this.listeners) fn(this.view());
  }
  private log(layer: LogEntry['layer'], text: string): void {
    this.state.logs.push({ time: new Date(this.now()).toISOString(), layer, text: text.slice(0, 1200) });
    this.state.logs = this.state.logs.slice(-80);
    this.emit();
  }
  private invalidate(status: AttemptStatus = 'superseded'): void {
    this.stopAttempt?.(status);
    this.state.revision++;
    this.active?.abort(); this.active = undefined;
  }
  private charge(): void {
    if (this.state.outcome || this.state.clock.running === null) return;
    const color = this.state.clock.running;
    const { timeout } = chargeClock(this.state.clock, this.state.match.settings, this.now());
    if (timeout) { this.finish(other(color), timeout); return; }
  }
  // Main-process heartbeat is only a notification driver. Every move, retry,
  // cancellation and resignation also checks deadlines BEFORE applying an action.
  tick(): void {
    if (this.state.clock.running === null) return;
    this.charge();
    if (this.turnTimer) this.state.progress = this.turnTimer.progress();
    this.emit();
  }
  private finish(winner: Color | 'draw', reason: ResultReason): void {
    if (this.state.outcome) return; // idempotent timeout/response races
    this.invalidate(reason === 'main-time' ? 'timeout' : 'cancelled');
    this.state.clock.running = null; this.state.status = 'over'; this.state.error = null;
    if (this.state.plan) this.state.plan = { ...this.state.plan, status: 'invalidated', reviewReason: '本局结束，计划失效' };
    const match = this.state.match;
    this.state.outcome = { gameId: this.state.id, number: match.rounds.length + 1, humanColor: this.state.human, winner, reason };
    match.rounds.push({ ...this.state.outcome });
    if (winner === 'draw') match.draws++;
    else if (winner === this.state.human) match.humanWins++;
    else match.machineWins++;
    const target = Math.ceil(match.settings.bestOf / 2);
    if (match.humanWins >= target) match.winner = 'human';
    if (match.machineWins >= target) match.winner = 'machine';
    const reasonText = REASON_TEXT[reason];
    this.log('business', `本局结算：${reasonText} · 你 ${match.humanWins} : ${match.machineWins} LLM${match.winner ? ' · 比赛结束' : ''}`);
  }
  private calculate(position: Position): void {
    this.state.position = replay(position.moves);
    this.state.analysis = this.analyze(this.state.position);
    this.state.plan = planForPosition(this.state.plan, this.state.position);
    this.state.evaluations.push(structuredClone(this.state.analysis));
    this.state.revision++;
    this.state.error = null;
    if (position.winner) { this.finish(position.winner, position.endReason!); return; }
    // Deadline was checked at receipt, before validation/replay. A move accepted
    // in time must not turn into a timeout during deterministic board calculation.
    switchClock(this.state.clock, this.state.match.settings, position.next);
    this.state.status = this.state.position.next === this.state.human ? 'human' : 'paused';
    this.log('business', `第 ${position.moves.length} 手：全谱重放、走法与将帅安全校验完成`);
  }
  humanMove(point: MoveInput, revision: number): GameState {
    this.charge();
    if (revision !== this.state.revision) throw new Error('棋盘已更新或本局已结束，请重新确认');
    if (this.state.status !== 'human' || this.state.position.next !== this.state.human) throw new Error('请等待机器方行棋');
    this.calculate(play(this.state.position, point));
    this.startAgent();
    return this.view();
  }
  newGame(human: Color, settings: MatchSettings = this.state.match.settings): GameState {
    if (human !== 1 && human !== 2) throw new Error('无效的执棋方');
    const match = this.newMatch(settings); // validate BEFORE invalidating the current game
    this.charge(); this.invalidate();
    this.state = this.fresh(human, this.state.model, match);
    this.log('business', `新比赛：${settings.bestOf === 3 ? '三局两胜' : '五局三胜'}；双方独立棋钟，局间交换红黑，和棋重赛`);
    this.startAgent(); return this.view();
  }
  nextRound(): GameState {
    if (!this.state.outcome) throw new Error('当前局尚未结束');
    if (this.state.match.winner) throw new Error('比赛已经结束，请开始新比赛');
    const human = this.state.outcome.winner === 'draw' ? this.state.human : other(this.state.human);
    this.invalidate(); this.state = this.fresh(human, this.state.model, structuredClone(this.state.match));
    this.log('business', `第 ${this.state.match.rounds.length + 1} 盘开始，${human === 1 ? '你' : 'LLM'}执红先行；双方时钟重新分配`);
    this.startAgent(); return this.view();
  }
  resign(): GameState {
    this.charge();
    if (this.state.outcome) throw new Error('本局已结束');
    this.finish(other(this.state.human), 'resign'); return this.view();
  }
  setModel(model: ModelChoice): GameState {
    this.charge(); this.invalidate(); this.state.model = { ...model }; this.state.error = null; this.state.plan = null;
    this.state.status = this.state.outcome ? 'over' : this.state.position.next === this.state.human ? 'human' : 'paused';
    this.log('agent', `已选择 ${model.provider}/${model.id}；行棋方时钟不停、不重置`);
    return this.view();
  }
  cancel(): GameState {
    this.charge();
    if (this.state.status === 'thinking') {
      this.invalidate('cancelled'); this.state.status = 'paused'; this.state.error = null;
      this.log('agent', '模型请求已取消，但比赛棋钟继续；可重试或认输');
    }
    return this.view();
  }
  undo(): GameState {
    this.charge();
    if (this.state.outcome) throw new Error('已结算的棋局不能悔棋');
    if (!this.state.match.settings.allowUndo) throw new Error('比赛模式不允许悔棋；可在新比赛设置中启用练习悔棋');
    this.invalidate();
    const moves = this.state.position.moves.slice();
    let lastHuman = moves.length - 1;
    while (lastHuman >= 0 && moves[lastHuman].color !== this.state.human) lastHuman--;
    if (lastHuman >= 0) moves.splice(lastHuman);
    else moves.splice(0);
    this.state.position = replay(moves);
    this.state.analysis = this.analyze(this.state.position);
    this.state.evaluations = this.state.evaluations.slice(0, moves.length);
    this.state.notes = this.state.notes.filter(n => n.ply <= moves.length);
    this.state.plan = null; // never carry a plan from the abandoned future branch
    // Practice only: never refund time or grant a Fischer increment on undo.
    this.state.clock.running = this.state.position.next; this.state.clock.turnElapsedMs = 0;
    this.state.error = null;
    this.state.status = this.state.position.next === this.state.human ? 'human' : 'paused';
    this.log('business', '练习悔棋完成：重建棋盘，不返还已用时间、不额外加秒');
    return this.view();
  }
  retry(): GameState {
    this.charge();
    if (this.state.status === 'thinking') throw new Error('机器方正在思考');
    this.startAgent(); return this.view();
  }
  private startAgent(): void {
    this.charge();
    if (this.state.outcome || this.state.position.next === this.state.human) { this.emit(); return; }
    if (!this.state.model) {
      this.state.status = 'error'; this.state.error = '未配置可用模型：请先在 Pi 中 /login，或设置 API Key 后重启应用。比赛棋钟仍会继续。'; this.emit(); return;
    }
    const controller = new AbortController(); this.active = controller;
    const id = this.state.id, revision = this.state.revision;
    const timer = new TurnTimer(this.now, revision); this.turnTimer = timer;
    this.state.progress = timer.progress();
    this.state.status = 'thinking'; this.state.error = null;
    const attemptId = randomUUID();
    this.stopAttempt = status => {
      if (this.turnTimer !== timer) return;
      const timing = timer.finish();
      this.state.attempts = [...(this.state.attempts ?? []), { id: attemptId, revision,
        ply: this.state.position.moves.length + 1, model: `${this.state.model!.provider}/${this.state.model!.id}`, status, timing }].slice(-80);
      this.turnTimer = undefined; this.stopAttempt = undefined; delete this.state.progress;
      this.emit(); // also saves a failed attempt when revision has not changed
    };
    this.log('agent', 'Agent Loop 启动：发送完整棋谱与紧凑业务信号');
    const snapshot = this.snapshot();
    let committed = false, submitting = false, searching = false, searchMs = 0, searchNodes = 0;
    let stagedPlan = structuredClone(snapshot.plan), planUpdate: PlanUpdate | undefined;
    let stagedDecision: DecisionTrace | undefined, reviewNumber = 0;
    const publishProgress = () => {
      if (this.turnTimer === timer) { this.state.progress = timer.progress(); this.emit(); }
    };
    const valid = () => !controller.signal.aborted && !this.state.outcome && this.state.id === id && this.state.revision === revision && this.active === controller;
    const search = async (requested: SearchOptions = {}, final = false, signal?: AbortSignal): Promise<SearchReport> => {
      this.charge();
      if (signal?.aborted) throw new Error('搜索请求已取消');
      if (!valid() || searching || (!final && submitting)) throw new Error('回合失效或已有搜索/提交正在执行');
      const opts = liveSearchOptions(snapshot.position, this.state.clock.players[snapshot.position.next].mainMs, requested);
      opts.maxMs = Math.max(0, Math.min(opts.maxMs!, TURN_SEARCH_MS - searchMs - (final ? 0 : FINAL_SEARCH_MS)));
      opts.maxNodes = Math.max(0, Math.min(opts.maxNodes!, TURN_SEARCH_NODES - searchNodes - (final ? 0 : 20000)));
      searchMs += opts.maxMs; searchNodes += opts.maxNodes; searching = true;
      try {
        const report = await this.searchDriver.search(snapshot.position, opts, signal ? AbortSignal.any([controller.signal, signal]) : controller.signal);
        this.charge();
        if (signal?.aborted) throw new Error('搜索请求已取消');
        if (!valid()) throw new Error('搜索期间回合已失效或棋钟耗尽');
        if (!final && snapshot.analysis.expert) {
          snapshot.analysis.expert.search = report;
          if (this.state.analysis.expert) this.state.analysis.expert.search = report;
        }
        this.log('business', `多步搜索：完成 ${report.completedDepth} 层 · ${report.nodes} 节点 · ${report.rootScope} · ${report.stopped}`);
        return report;
      } finally { searching = false; }
    };
    const port: TurnPort = {
      state: snapshot, signal: controller.signal,
      recall: (position, reviews) => {
        if (!valid()) throw new Error('回合已失效，拒绝检索案例');
        return recallExperience(position, position === snapshot.position ? snapshot.analysis.expert : analyzeExpert(position, { candidateLimit: 4 }).expert, this.cases(), reviews);
      },
      log: (layer, text) => { if (valid()) this.log(layer, text); },
      telemetry: event => { if (valid() && !committed && timer.event(event)) publishProgress(); },
      search: (options, signal) => search(options, false, signal),
      setDecision: trace => {
        if (!valid() || committed) return;
        if (trace.version !== SKILLS_VERSION || trace.revision !== revision) throw new Error('决策审计版本与回合不符');
        stagedDecision = structuredClone(trace);
      },
      updatePlan: input => {
        this.charge();
        if (!valid() || submitting || searching || committed) throw new Error('回合失效或正在提交，不能更新计划');
        stagedPlan = updatePlan(snapshot.position, stagedPlan, input);
        planUpdate = structuredClone(input); snapshot.plan = structuredClone(stagedPlan);
        return structuredClone(stagedPlan);
      },
      commit: async (point, reason, riskAcknowledgement, signal) => {
        this.charge(); // a late response cannot win against an expired clock
        if (signal?.aborted) throw new Error('落子请求已取消');
        // Never allow a caller to change the proposed coordinates while the
        // asynchronous independent review is running.
        point = { from: { ...point.from }, to: { ...point.to } };
        if (!valid() || committed || submitting || searching) throw new Error('过期、超时、并发或重复的落子请求已拒绝');
        if (this.state.position.next !== other(this.state.human)) throw new Error('不是机器方回合');
        if (typeof reason !== 'string' || !reason.trim() || reason.length > 600) throw new Error('请提供不超过 600 字的简短落子理由');
        if (riskAcknowledgement !== undefined && (typeof riskAcknowledgement !== 'string' || riskAcknowledgement.trim().length < 12 || riskAcknowledgement.length > 400)) throw new Error('风险说明须为 12–400 字，说明具体补偿或不可避免的败势');
        // This is authoritative, not dependent on the LLM voluntarily calling a
        // review tool. A heuristic warning is overridable: don't outlaw sacrifices.
        const reviewId = `business-review-${++reviewNumber}`;
        timer.event({ type: 'start', id: reviewId, kind: 'review', name: 'independent-review' }); publishProgress();
        let reviewOk = false;
        try {
          let review = reviewMove(this.state.position, point);
          this.charge(); // expert computation also spends the machine's clock
          if (!valid()) throw new Error('审查期间回合已过期或棋钟耗尽');
          submitting = true;
          try {
            // Independently search the actual submitted move, even if the model
            // never asked for analysis or searched a different shortlist.
            const report = await search({ moves: [point], maxMs: FINAL_SEARCH_MS, maxNodes: 20000, maxDepth: 5 }, true, signal);
            review = mergeSearchReview(snapshot.position, review, report);
          } catch (error) {
            if (!valid() || signal?.aborted) throw error;
            review.searchError = error instanceof Error ? error.message : String(error);
            review.warnings.push('多步复查失败：未知，不是安全结论；仍执行原有单步与交换审查。');
            this.log('business', `多步复查未完成：${review.searchError}`);
          } finally { submitting = false; }
          this.charge();
          if (signal?.aborted) throw new Error('落子请求已取消');
          if (!valid() || committed) throw new Error('多步审查期间回合已过期或棋钟耗尽');
          if (needsRiskAcknowledgement(review) && !riskAcknowledgement?.trim()) {
            this.log('business', `专家审查要求重新考虑：${review.notation} · ${review.risk} · 交换估计 ${review.estimatedNet} · ${review.line.slice(1).join(' → ')}`);
            throw new MoveRiskError(review);
          }
          const position = play(this.state.position, point);
          reviewOk = true; timer.event({ type: 'end', id: reviewId, ok: true });
          committed = true;
          const timing = timer.finish(true);
          this.turnTimer = undefined; this.stopAttempt = undefined; delete this.state.progress;
          // tool_execution_end occurs AFTER calculate emits/autosaves. Finalize the
          // accepted commit inside this transaction, never patch an emitted note.
          const decision = stagedDecision ? structuredClone(stagedDecision) : undefined;
          if (decision) recordDecisionTool(decision, 'move_piece', true);
          this.state.notes.push({ ply: position.moves.length, reason: reason.trim(), elapsedMs: timing.totalMs, timing,
            model: `${snapshot.model!.provider}/${snapshot.model!.id}`, review,
            ...(decision ? { decision } : {}),
            plan: structuredClone(stagedPlan), ...(planUpdate ? { planUpdate: structuredClone(planUpdate) } : {}),
            ...(riskAcknowledgement ? { riskAcknowledgement: riskAcknowledgement.trim() } : {}) });
          this.state.plan = structuredClone(stagedPlan);
          this.calculate(position);
        } finally {
          timer.event({ type: 'end', id: reviewId, ok: reviewOk }); publishProgress();
        }
      },
    };
    // Request errors, retries and cancel never reset the competition clock.
    void this.driver.run(port).then(() => {
      if (valid() && !committed) throw new Error('模型未调用落子工具，请重试或切换支持工具调用的模型');
    }).catch(error => {
      this.charge();
      if (valid() && !committed) {
        this.stopAttempt?.('error');
        this.state.status = 'error'; this.state.error = error instanceof Error ? error.message : String(error);
        this.log('agent', `本回合未落子，棋钟继续：${this.state.error}`);
      }
    }).finally(() => { if (this.active === controller) this.active = undefined; });
  }
  record(): GameRecord {
    return { format: 'chinese-chess/v1', id: this.state.id, savedAt: new Date(this.now()).toISOString(), human: this.state.human,
      model: structuredClone(this.state.model), moves: structuredClone(this.state.position.moves),
      evaluations: structuredClone(this.state.evaluations), notes: structuredClone(this.state.notes), plan: structuredClone(this.state.plan),
      result: this.state.outcome?.winner ?? null, outcome: structuredClone(this.state.outcome),
      clock: structuredClone(this.state.clock), match: structuredClone(this.state.match),
      ...(this.state.attempts?.length ? { attempts: structuredClone(this.state.attempts) } : {}) };
  }
  dispose(): void { this.invalidate('cancelled'); this.state.clock.running = null; this.listeners.clear(); }
}
