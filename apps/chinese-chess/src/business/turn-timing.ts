// Host-owned wall-clock observations only. No Pi, model text or tool arguments.
export const TIMING_VERSION = 'xiangqi-timing/v1' as const;
export type TimingKind = 'setup' | 'pre-search' | 'model' | 'tool' | 'review';
export type AttemptStatus = 'error' | 'cancelled' | 'timeout' | 'superseded';
export type TimingEvent =
  | { type: 'start'; id: string; kind: TimingKind; name: string }
  | { type: 'end'; id: string; ok: boolean }
  | { type: 'first-delta'; id: string };
export interface TimingSpan {
  id: string; kind: TimingKind; name: string; startMs: number; durationMs: number;
  status: 'running' | 'ok' | 'error' | 'interrupted'; firstDeltaMs?: number;
}
export interface TurnTiming {
  version: typeof TIMING_VERSION; totalMs: number;
  breakdown: { modelMs: number; toolMs: number; preSearchMs: number; reviewMs: number; otherMs: number };
  spans: TimingSpan[];
}
export interface TurnAttempt {
  id: string; revision: number; ply: number; model: string; status: AttemptStatus; timing: TurnTiming;
}
export interface TurnProgress {
  revision: number; elapsedMs: number; phase: TimingKind | 'preparing'; name?: string;
  receiving: boolean; requests: number; tools: number;
}
export function recordSaveKey(state: { id: string; revision: number; attempts?: Pick<TurnAttempt, 'id'>[] }): string {
  return `${state.id}/${state.revision}/${state.attempts?.at(-1)?.id ?? ''}`;
}
const priority: TimingKind[] = ['review', 'tool', 'model', 'pre-search', 'setup'];
export class TurnTimer {
  private readonly started: number;
  private last = 0;
  private spans: TimingSpan[] = [];
  private finished?: TurnTiming;
  constructor(private now: () => number, readonly revision: number) { this.started = now(); }
  private elapsed(): number {
    // Defensive monotonicity for injected clocks too; never touch chess clocks.
    this.last = Math.max(this.last, this.now() - this.started, 0); return this.last;
  }
  event(event: TimingEvent): boolean {
    if (this.finished) return false;
    const at = this.elapsed(), span = this.spans.find(s => s.id === event.id);
    if (event.type === 'start') {
      if (span || this.spans.length >= 128) return false;
      this.spans.push({ id: event.id, kind: event.kind, name: event.name, startMs: at, durationMs: 0, status: 'running' });
    } else {
      if (!span || span.status !== 'running') return false;
      if (event.type === 'first-delta') {
        if (span.kind !== 'model' || span.firstDeltaMs !== undefined) return false;
        span.firstDeltaMs = at - span.startMs;
      } else { span.durationMs = at - span.startMs; span.status = event.ok ? 'ok' : 'error'; }
    }
    return true;
  }
  progress(): TurnProgress {
    const active = this.spans.filter(s => s.status === 'running');
    const current = priority.flatMap(kind => active.filter(s => s.kind === kind)).at(0);
    return { revision: this.revision, elapsedMs: this.finished?.totalMs ?? this.elapsed(),
      phase: current?.kind ?? 'preparing', name: current?.name, receiving: current?.firstDeltaMs !== undefined,
      requests: this.spans.filter(s => s.kind === 'model').length, tools: this.spans.filter(s => s.kind === 'tool').length };
  }
  snapshot(): TurnTiming {
    if (this.finished) return structuredClone(this.finished);
    const totalMs = this.elapsed();
    const spans = this.spans.map(s => ({ ...s, durationMs: s.status === 'running' ? totalMs - s.startMs : s.durationMs }));
    const breakdown = { modelMs: 0, toolMs: 0, preSearchMs: 0, reviewMs: 0, otherMs: 0 };
    const points = [...new Set([0, totalMs, ...spans.flatMap(s => [s.startMs, s.startMs + s.durationMs])])].sort((a, b) => a - b);
    for (let i = 1; i < points.length; i++) {
      const from = points[i - 1], to = points[i];
      const kind = priority.find(kind => spans.some(s => s.kind === kind && s.startMs <= from && s.startMs + s.durationMs >= to));
      const key = kind === 'model' ? 'modelMs' : kind === 'tool' ? 'toolMs' : kind === 'review' ? 'reviewMs' : kind === 'pre-search' ? 'preSearchMs' : 'otherMs';
      breakdown[key] += to - from;
    }
    return { version: TIMING_VERSION, totalMs, breakdown, spans };
  }
  finish(accepted = false): TurnTiming {
    if (!this.finished) {
      const timing = this.snapshot();
      for (const span of timing.spans) if (span.status === 'running') {
        span.status = accepted && span.kind === 'tool' && span.name === 'move_piece' ? 'ok' : 'interrupted';
      }
      this.finished = timing;
    }
    return structuredClone(this.finished);
  }
}
