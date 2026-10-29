import type { Analysis, Color, Move, Position } from '../business/engine';
export interface ModelChoice { provider: string; id: string; name: string }
export interface TurnNote { ply: number; reason: string; model: string; elapsedMs: number }
export interface LogEntry { time: string; layer: 'business' | 'extension' | 'agent'; text: string }
export interface MatchSettings {
  bestOf: 3 | 5;
  timeControl: 'byoyomi' | 'absolute';
  mainTimeMs: number;
  periodTimeMs: number;
  periods: number;
  allowUndo: boolean;
}
export interface PlayerClock {
  mainMs: number;
  periodMs: number;
  periodsLeft: number;
}
export interface ClockState {
  players: Record<Color, PlayerClock>;
  running: Color | null;
  turnElapsedMs: number;
  updatedAt: number;
}
export type ResultReason = 'five' | 'draw' | 'main-time' | 'byoyomi' | 'resign';
export interface RoundResult {
  gameId: string;
  number: number;
  humanColor: Color;
  winner: Color | 'draw';
  reason: ResultReason;
}
export interface MatchState {
  id: string;
  settings: MatchSettings;
  humanWins: number;
  machineWins: number;
  draws: number;
  rounds: RoundResult[];
  winner: 'human' | 'machine' | null;
}
export interface GameState {
  id: string;
  revision: number;
  human: Color;
  position: Position;
  analysis: Analysis;
  evaluations: Analysis[];
  notes: TurnNote[];
  status: 'human' | 'thinking' | 'paused' | 'error' | 'over';
  error: string | null;
  logs: LogEntry[];
  model: ModelChoice | null;
  clock: ClockState;
  match: MatchState;
  outcome: RoundResult | null;
}
export interface GameRecord {
  format: 'five-llm/v1';
  id: string;
  savedAt: string;
  human: Color;
  model: ModelChoice | null;
  moves: Move[];
  evaluations: Analysis[];
  notes: TurnNote[];
  result: Position['winner'];
  outcome: RoundResult | null;
  clock: ClockState;
  match: MatchState;
}
export type Command =
  | { type: 'move'; x: number; y: number; revision: number }
  | { type: 'new'; human: Color; settings?: MatchSettings }
  | { type: 'next-round' }
  | { type: 'resign' }
  | { type: 'undo' }
  | { type: 'retry' }
  | { type: 'cancel' }
  | { type: 'model'; provider: string; id: string };
export interface Bootstrap { state: GameState; models: ModelChoice[]; setupError: string | null }
export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
export interface DesktopAPI {
  bootstrap(): Promise<Reply<Bootstrap>>;
  command(command: Command): Promise<Reply<GameState>>;
  exportRecord(): Promise<Reply<string | null>>;
  onState(listener: (state: GameState) => void): () => void;
}
declare global { interface Window { five: DesktopAPI } }
