import type { Analysis, BoardReason, Color, Move, MoveInput, Position } from '../business/engine';
import type { LearningOverview, PostGameReview } from '../business/learning';
import type { MoveReview } from '../business/expert';
export interface ModelChoice { provider: string; id: string; name: string }
export interface TurnNote { ply: number; reason: string; model: string; elapsedMs: number; review?: MoveReview; riskAcknowledgement?: string }
export interface LogEntry { time: string; layer: 'business' | 'extension' | 'agent'; text: string }
export interface MatchSettings {
  bestOf: 3 | 5;
  timeControl: 'fischer' | 'absolute';
  mainTimeMs: number;
  incrementMs: number;
  allowUndo: boolean;
}
export interface PlayerClock { mainMs: number }
export interface ClockState {
  players: Record<Color, PlayerClock>;
  running: Color | null;
  turnElapsedMs: number;
  updatedAt: number;
}
export type ResultReason = BoardReason | 'main-time' | 'resign';
export const REASON_TEXT: Record<ResultReason, string> = {
  checkmate: '将死', stalemate: '困毙（无子可走判负）', repetition: '三次重复和棋',
  'perpetual-check': '单方长将判负', 'no-progress': '连续 120 半回合无吃子、无兵卒移动', 'main-time': '棋钟耗尽', resign: '认输',
};
export interface RoundResult { gameId: string; number: number; humanColor: Color; winner: Color | 'draw'; reason: ResultReason }
export interface MatchState {
  id: string; settings: MatchSettings; humanWins: number; machineWins: number; draws: number;
  rounds: RoundResult[]; winner: 'human' | 'machine' | null;
}
export interface GameState {
  id: string; revision: number; human: Color; position: Position; analysis: Analysis; evaluations: Analysis[];
  notes: TurnNote[]; status: 'human' | 'thinking' | 'paused' | 'error' | 'over'; error: string | null;
  logs: LogEntry[]; model: ModelChoice | null; clock: ClockState; match: MatchState; outcome: RoundResult | null;
}
export interface GameRecord {
  format: 'chinese-chess/v1'; id: string; savedAt: string; human: Color; model: ModelChoice | null;
  moves: Move[]; evaluations: Analysis[]; notes: TurnNote[]; result: Position['winner'];
  outcome: RoundResult | null; clock: ClockState; match: MatchState;
}
export type Command =
  | ({ type: 'move'; revision: number } & MoveInput)
  | { type: 'new'; human: Color; settings?: MatchSettings }
  | { type: 'next-round' } | { type: 'resign' } | { type: 'undo' } | { type: 'retry' } | { type: 'cancel' }
  | { type: 'model'; provider: string; id: string };
export interface Bootstrap { state: GameState; models: ModelChoice[]; setupError: string | null; learning: LearningOverview }
export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
export interface DesktopAPI {
  bootstrap(): Promise<Reply<Bootstrap>>;
  command(command: Command): Promise<Reply<GameState>>;
  /** Pushed states omit per-ply evaluations; fetch one when reviewing history. */
  evaluation(id: string, ply: number): Promise<Reply<Analysis | null>>;
  exportRecord(): Promise<Reply<string | null>>;
  reviewGame(id: string): Promise<Reply<PostGameReview | null>>;
  rescanLearning(): Promise<Reply<LearningOverview>>;
  onLearning(listener: (overview: LearningOverview) => void): () => void;
  onState(listener: (state: GameState) => void): () => void;
}
declare global { interface Window { chess: DesktopAPI } }
