import { parentPort, workerData } from 'node:worker_threads';
import { searchPosition } from '../business/search';
try {
  const remaining = Math.max(0, Math.min(workerData.options.maxMs, workerData.deadline - Date.now()));
  const report = searchPosition(workerData.position, { ...workerData.options, maxMs: remaining });
  parentPort!.postMessage({ report });
} catch (e) { parentPort!.postMessage({ error: e instanceof Error ? e.message : String(e) }); }
parentPort!.close();
