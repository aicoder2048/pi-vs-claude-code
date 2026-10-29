import type { Color } from './engine';
import type { ClockState, MatchSettings, ResultReason } from '../shared/types';

export const DEFAULT_SETTINGS: Readonly<MatchSettings> = Object.freeze({
  bestOf: 3, timeControl: 'byoyomi', mainTimeMs: 10 * 60_000,
  periodTimeMs: 60_000, periods: 3, allowUndo: false,
});
export function validateSettings(value: unknown): MatchSettings {
  if (!value || typeof value !== 'object') throw new Error('无效的比赛设置');
  const s = value as Record<string, unknown>;
  if (s.bestOf !== 3 && s.bestOf !== 5) throw new Error('赛制只能为三局两胜或五局三胜');
  if (s.timeControl !== 'byoyomi' && s.timeControl !== 'absolute') throw new Error('未知计时规则');
  if (!Number.isSafeInteger(s.mainTimeMs) || (s.mainTimeMs as number) < (s.timeControl === 'absolute' ? 1 : 0) || (s.mainTimeMs as number) > 3 * 3600_000) throw new Error('基本用时必须为 0–180 分钟，包干制必须大于零');
  if (!Number.isSafeInteger(s.periodTimeMs) || (s.periodTimeMs as number) < 1 || (s.periodTimeMs as number) > 300_000) throw new Error('每次读秒须在 0–300 秒内且大于零');
  if (!Number.isSafeInteger(s.periods) || (s.periods as number) < 1 || (s.periods as number) > 10) throw new Error('读秒次数须为 1–10');
  if (typeof s.allowUndo !== 'boolean') throw new Error('无效的悔棋设置');
  return { bestOf: s.bestOf, timeControl: s.timeControl, mainTimeMs: s.mainTimeMs as number,
    periodTimeMs: s.periodTimeMs as number, periods: s.periods as number, allowUndo: s.allowUndo };
}
export function newClock(settings: MatchSettings, now: number, running: Color | null = 1): ClockState {
  const player = () => ({ mainMs: settings.mainTimeMs, periodMs: settings.periodTimeMs, periodsLeft: settings.periods });
  return { players: { 1: player(), 2: player() }, running, turnElapsedMs: 0, updatedAt: now };
}
// Pure accounting: elapsed time is charged exactly once to the active color.
// A delayed heartbeat consumes ALL crossed periods, never just one callback.
export function chargeClock(clock: ClockState, settings: MatchSettings, now: number): { lostPeriods: number; timeout: ResultReason | null } {
  const elapsed = Math.max(0, now - clock.updatedAt);
  clock.updatedAt = Math.max(clock.updatedAt, now);
  if (clock.running === null) return { lostPeriods: 0, timeout: null };
  clock.turnElapsedMs += elapsed;
  const player = clock.players[clock.running];
  const mainUsed = Math.min(player.mainMs, elapsed);
  player.mainMs -= mainUsed;
  let remaining = elapsed - mainUsed;
  if (settings.timeControl === 'absolute') return { lostPeriods: 0, timeout: player.mainMs <= 0 ? 'main-time' : null };
  let lostPeriods = 0;
  // At an exact deadline expiry wins over a move; UI rounds UP, adjudication does not.
  while (player.mainMs === 0 && remaining >= player.periodMs) {
    remaining -= player.periodMs;
    player.periodsLeft--; lostPeriods++;
    player.periodMs = settings.periodTimeMs;
    if (player.periodsLeft === 0) { player.periodMs = 0; return { lostPeriods, timeout: 'byoyomi' }; }
  }
  if (player.mainMs === 0) player.periodMs -= remaining;
  return { lostPeriods, timeout: null };
}
export function switchClock(clock: ClockState, settings: MatchSettings, next: Color): void {
  // A completed move restores only the unused fraction of its current period,
  // NOT any previously consumed periods or main time.
  if (clock.running !== null) clock.players[clock.running].periodMs = settings.periodTimeMs;
  clock.running = next; clock.turnElapsedMs = 0;
}
