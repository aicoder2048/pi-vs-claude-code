import { Worker } from 'node:worker_threads';
import type { LearningOverview, PostGameReview, TacticalCase } from '../business/learning';
import type { LearningDatabase } from './library';
export class LearningCoordinator {
  cases: readonly TacticalCase[] = [];
  private reviews: PostGameReview[] = [];
  private listeners = new Set<(overview: LearningOverview) => void>();
  private worker: Worker;
  private stopped = false;
  private overview: LearningOverview = { status: 'starting', activeGame: null, processedPlies: 0, totalPlies: 0, caseCount: 0, reviews: [], errors: [] };
  constructor(userData: string, workerPath: string | URL) {
    this.worker = new Worker(workerPath, { workerData: { userData } });
    this.worker.on('message', (m: { type: string; overview?: LearningOverview; database?: LearningDatabase }) => {
      if (m.type !== 'update' || !m.overview) return;
      if (m.database) { this.cases = m.database.cases; this.reviews = m.database.reviews; }
      this.overview = m.overview; this.emit();
    });
    this.worker.on('error', error => { this.overview = { ...this.overview, status: 'error', errors: [...this.overview.errors, error.message] }; this.emit(); });
    this.worker.on('exit', code => { if (!this.stopped) { this.overview = { ...this.overview, status: 'error', errors: [...this.overview.errors, `复盘 Worker 意外退出 (${code})，未完成棋谱将在下次启动重新处理`] }; this.emit(); } });
  }
  private emit() { for (const fn of this.listeners) fn(this.snapshot()); }
  snapshot(): LearningOverview { return structuredClone(this.overview); }
  review(id: string): PostGameReview | null { return structuredClone(this.reviews.find(r => r.gameId === id) ?? null); }
  subscribe(fn: (overview: LearningOverview) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  enqueue(id: string) { if (!this.stopped) this.worker.postMessage({ type: 'enqueue', id }); }
  scan() { if (!this.stopped) this.worker.postMessage({ type: 'scan' }); }
  async close(): Promise<void> {
    if (this.stopped) return; this.stopped = true;
    await Promise.race([new Promise<void>(resolve => {
      this.worker.on('message', m => { if (m.type === 'stopped') resolve(); }); this.worker.once('exit', () => resolve()); this.worker.postMessage({ type: 'stop' });
    }), new Promise(resolve => setTimeout(resolve, 2000))]);
    await this.worker.terminate(); this.listeners.clear();
  }
}
