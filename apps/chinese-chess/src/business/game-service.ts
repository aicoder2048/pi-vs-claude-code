import { randomUUID } from 'node:crypto';
import { emptyPosition, other, play, replay, type Analysis, type Color, type MoveInput, type Position } from './engine';
import { chargeClock, DEFAULT_SETTINGS, newClock, switchClock, validateSettings } from './clock';
import { analyzeExpert, MoveRiskError, needsRiskAcknowledgement, reviewMove } from './expert';
import { recallExperience, type TacticalCase } from './learning';
import { retrieveKnowledge } from './knowledge';
import { REASON_TEXT } from '../shared/types';
import type { GameRecord, GameState, LogEntry, MatchSettings, MatchState, ModelChoice, ResultReason } from '../shared/types';

// Dependency inversion: the domain knows this port, not Pi's implementation.
export interface TurnPort {
  state: GameState;
  signal: AbortSignal;
  recall?(position: Position, reviews?: import('./expert').MoveReview[]): import('./learning').ExperienceHint[];
  log(layer: LogEntry['layer'], text: string): void;
  commit(point: MoveInput, reason: string, riskAcknowledgement?: string): void;
}
export interface AgentDriver { run(port: TurnPort): Promise<void> }
export interface ServiceOptions { now?: () => number; settings?: MatchSettings; cases?: () => readonly TacticalCase[] }
export class GameService {
  private state: GameState;
  private active?: AbortController;
  private listeners = new Set<(state: GameState) => void>();
  private readonly now: () => number;
  private readonly cases: () => readonly TacticalCase[];
  constructor(private driver: AgentDriver, model: ModelChoice | null = null, options: ServiceOptions = {}) {
    this.cases = options.cases ?? (() => []);
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
      clock: newClock(match.settings, this.now()), position, analysis: this.analyze(position), evaluations: [], notes: [],
      status: human === 1 ? 'human' : 'paused', error: null, logs: [] };
  }
  snapshot(): GameState { return structuredClone(this.state); }
  // What subscribers and command replies get. Per-ply evaluations grow to MBs
  // over a long game and the 5 Hz heartbeat would clone them every tick, so
  // they are left out; read one with evaluation(ply) when reviewing history.
  view(): GameState { return structuredClone({ ...this.state, evaluations: [] }); }
  evaluation(gameId: string, ply: number): Analysis | null {
    if (gameId !== this.state.id || !Number.isSafeInteger(ply) || ply < 1) return null;
    return structuredClone(this.state.evaluations[ply - 1] ?? null);
  }
  subscribe(fn: (state: GameState) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(): void { for (const fn of this.listeners) fn(this.view()); }
  private log(layer: LogEntry['layer'], text: string): void {
    this.state.logs.push({ time: new Date(this.now()).toISOString(), layer, text: text.slice(0, 1200) });
    this.state.logs = this.state.logs.slice(-80);
    this.emit();
  }
  private invalidate(): void {
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
    this.charge(); this.emit();
  }
  private finish(winner: Color | 'draw', reason: ResultReason): void {
    if (this.state.outcome) return; // idempotent timeout/response races
    this.invalidate();
    this.state.clock.running = null; this.state.status = 'over'; this.state.error = null;
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
    this.charge(); this.invalidate(); this.state.model = { ...model }; this.state.error = null;
    this.state.status = this.state.outcome ? 'over' : this.state.position.next === this.state.human ? 'human' : 'paused';
    this.log('agent', `已选择 ${model.provider}/${model.id}；行棋方时钟不停、不重置`);
    return this.view();
  }
  cancel(): GameState {
    this.charge();
    if (this.state.status === 'thinking') {
      this.invalidate(); this.state.status = 'paused'; this.state.error = null;
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
    const id = this.state.id, revision = this.state.revision, started = this.now();
    this.state.status = 'thinking'; this.state.error = null;
    this.log('agent', 'Agent Loop 启动：发送完整棋谱与业务层计算结果');
    const snapshot = this.snapshot();
    let committed = false;
    const valid = () => !controller.signal.aborted && !this.state.outcome && this.state.id === id && this.state.revision === revision && this.active === controller;
    const port: TurnPort = {
      state: snapshot, signal: controller.signal,
      recall: (position, reviews) => {
        if (!valid()) throw new Error('回合已失效，拒绝检索案例');
        return recallExperience(position, position === snapshot.position ? snapshot.analysis.expert : analyzeExpert(position, { candidateLimit: 4 }).expert, this.cases(), reviews);
      },
      log: (layer, text) => { if (valid()) this.log(layer, text); },
      commit: (point, reason, riskAcknowledgement) => {
        this.charge(); // a late response cannot win against an expired clock
        if (!valid() || committed) throw new Error('过期、超时或重复的落子请求已拒绝');
        if (this.state.position.next !== other(this.state.human)) throw new Error('不是机器方回合');
        if (typeof reason !== 'string' || !reason.trim() || reason.length > 600) throw new Error('请提供不超过 600 字的简短落子理由');
        if (riskAcknowledgement !== undefined && (typeof riskAcknowledgement !== 'string' || riskAcknowledgement.trim().length < 12 || riskAcknowledgement.length > 400)) throw new Error('风险说明须为 12–400 字，说明具体补偿或不可避免的败势');
        // This is authoritative, not dependent on the LLM voluntarily calling a
        // review tool. A heuristic warning is overridable: don't outlaw sacrifices.
        const review = reviewMove(this.state.position, point);
        this.charge(); // expert computation also spends the machine's clock
        if (!valid()) throw new Error('审查期间回合已过期或棋钟耗尽');
        if (needsRiskAcknowledgement(review) && !riskAcknowledgement?.trim()) {
          this.log('business', `专家审查要求重新考虑：${review.notation} · ${review.risk} · 交换估计 ${review.estimatedNet} · ${review.line.slice(1).join(' → ')}`);
          throw new MoveRiskError(review);
        }
        const position = play(this.state.position, point);
        committed = true;
        this.state.notes.push({ ply: position.moves.length, reason: reason.trim(), elapsedMs: this.now() - started,
          model: `${snapshot.model!.provider}/${snapshot.model!.id}`, review,
          ...(riskAcknowledgement ? { riskAcknowledgement: riskAcknowledgement.trim() } : {}) });
        this.calculate(position);
      },
    };
    // Request errors, retries and cancel never reset the competition clock.
    void this.driver.run(port).then(() => {
      if (valid() && !committed) throw new Error('模型未调用落子工具，请重试或切换支持工具调用的模型');
    }).catch(error => {
      this.charge();
      if (valid() && !committed) {
        this.state.status = 'error'; this.state.error = error instanceof Error ? error.message : String(error);
        this.log('agent', `本回合未落子，棋钟继续：${this.state.error}`);
      }
    }).finally(() => { if (this.active === controller) this.active = undefined; });
  }
  record(): GameRecord {
    return { format: 'chinese-chess/v1', id: this.state.id, savedAt: new Date(this.now()).toISOString(), human: this.state.human,
      model: structuredClone(this.state.model), moves: structuredClone(this.state.position.moves),
      evaluations: structuredClone(this.state.evaluations), notes: structuredClone(this.state.notes),
      result: this.state.outcome?.winner ?? null, outcome: structuredClone(this.state.outcome),
      clock: structuredClone(this.state.clock), match: structuredClone(this.state.match) };
  }
  dispose(): void { this.invalidate(); this.state.clock.running = null; this.listeners.clear(); }
}
