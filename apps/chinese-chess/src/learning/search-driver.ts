import { Worker } from 'node:worker_threads';
import type { Position } from '../business/engine';
import { searchPosition, type SearchDriver, type SearchOptions, type SearchReport } from '../business/search';
export class WorkerSearchDriver implements SearchDriver {
  constructor(private workerPath: string | URL) {}
  async search(position: Position, options: SearchOptions, signal: AbortSignal): Promise<SearchReport> {
    if (signal.aborted) throw new Error('多步搜索已取消');
    const began = performance.now(), maxMs = Math.max(0, Math.min(1200, options.maxMs ?? 400));
    if (maxMs === 0 || options.maxNodes === 0) return searchPosition(position, { ...options, maxMs: 0, maxNodes: 0 });
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerPath, { workerData: { position, options: { maxMs, maxNodes: Math.max(0, Math.min(30000, options.maxNodes ?? 12000)), maxDepth: options.maxDepth ?? 5, moves: options.moves, quiescenceDepth: options.quiescenceDepth, extensions: options.extensions }, deadline: Date.now() + maxMs } });
      let settled = false;
      const finish = (error?: Error, report?: SearchReport) => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
        worker.removeAllListeners(); void worker.terminate().catch(() => {});
        if (error) reject(error); else { report!.elapsedMs = performance.now() - began; resolve(report!); }
      };
      const abort = () => finish(new Error('多步搜索已取消'));
      // Startup and IPC count towards wall budget. Hard watchdog protects against
      // a broken worker; the normal search loop has its own cooperative deadline.
      const timer = setTimeout(() => finish(new Error('多步搜索 Worker 超过硬时限，未采用结果')), maxMs + 150);
      signal.addEventListener('abort', abort, { once: true });
      worker.on('message', (m: { report?: SearchReport; error?: string }) => finish(m.error ? new Error(m.error) : m.report ? undefined : new Error('无效搜索响应'), m.report));
      worker.on('error', error => finish(error));
      worker.on('exit', code => { if (!settled) finish(new Error(`搜索 Worker 提前退出 (${code})`)); });
      if (signal.aborted) abort();
    });
  }
}
