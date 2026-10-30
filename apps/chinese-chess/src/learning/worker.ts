import { parentPort, workerData } from 'node:worker_threads';
import { LearningRunner } from './runner';
import type { LearningOverview } from '../business/learning';
const port = parentPort!;
const runner = new LearningRunner(workerData.userData, (overview, database) => port.postMessage({ type: 'update', overview, database }));
const fail = (e: unknown) => {
  const overview: LearningOverview = { ...runner.overview, status: 'error', errors: [...runner.overview.errors, String(e instanceof Error ? e.message : e)].slice(-10) };
  port.postMessage({ type: 'update', overview });
};
const ready = runner.initialize().then(() => runner.scan());
void ready.catch(fail);
port.on('message', message => {
  if (message?.type === 'stop') { void runner.stop().finally(() => { port.postMessage({ type: 'stopped' }); port.close(); }); return; }
  if (message?.type === 'scan') void ready.then(() => runner.scan()).catch(fail);
  if (message?.type === 'enqueue' && typeof message.id === 'string') void ready.then(() => runner.enqueue(message.id)).catch(fail);
});
