import type { Color } from './engine';
import type { ClockState, MatchSettings, ResultReason } from '../shared/types';
export const DEFAULT_SETTINGS: Readonly<MatchSettings> = Object.freeze({
  bestOf: 3, timeControl: 'absolute', mainTimeMs: 30 * 60_000, incrementMs: 0, allowUndo: false,
});
export function validateSettings(value: unknown): MatchSettings {
  if (!value || typeof value !== 'object') throw new Error('无效的比赛设置');
  const s = value as Record<string, unknown>;
  if (s.bestOf !== 3 && s.bestOf !== 5) throw new Error('赛制只能为三局两胜或五局三胜');
  if (s.timeControl !== 'fischer' && s.timeControl !== 'absolute') throw new Error('未知计时规则');
  if (!Number.isSafeInteger(s.mainTimeMs) || (s.mainTimeMs as number) < 1 || (s.mainTimeMs as number) > 10800000) throw new Error('局时须大于零且不超过 180 分钟');
  if (!Number.isSafeInteger(s.incrementMs) || (s.incrementMs as number) < 0 || (s.incrementMs as number) > 60000) throw new Error('每步加秒须在 0–60 秒之间');
  if (typeof s.allowUndo !== 'boolean') throw new Error('无效的悔棋设置');
  return { bestOf: s.bestOf, timeControl: s.timeControl, mainTimeMs: s.mainTimeMs as number, incrementMs: s.incrementMs as number, allowUndo: s.allowUndo };
}
export function newClock(settings: MatchSettings, now: number, running: Color | null = 1): ClockState {
  return { players: { 1: { mainMs: settings.mainTimeMs }, 2: { mainMs: settings.mainTimeMs } }, running, turnElapsedMs: 0, updatedAt: now };
}
export function chargeClock(clock: ClockState, _settings: MatchSettings, now: number): { timeout: ResultReason | null } {
  const elapsed = Math.max(0, now - clock.updatedAt);
  clock.updatedAt = Math.max(clock.updatedAt, now);
  if (clock.running === null) return { timeout: null };
  clock.turnElapsedMs += elapsed;
  const player = clock.players[clock.running];
  player.mainMs = Math.max(0, player.mainMs - elapsed);
  return { timeout: player.mainMs <= 0 ? 'main-time' : null };
}
export function switchClock(clock: ClockState, settings: MatchSettings, next: Color, increment = true): void {
  if (increment && clock.running !== null && settings.timeControl === 'fischer') clock.players[clock.running].mainMs += settings.incrementMs;
  clock.running = next; clock.turnElapsedMs = 0;
}
