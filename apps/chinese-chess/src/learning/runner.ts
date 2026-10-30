import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeRecord, recordFingerprint, reviewFinishedGame, summarizeReview, validGameId, type LearningOverview } from '../business/learning';
import { LearningLibrary, type LearningDatabase } from './library';
export class LearningRunner {
  private library: LearningLibrary;
  private db: LearningDatabase = { format: 'xiangqi-learning/v1', validator: '', cases: [], reviews: [] };
  private queue = new Set<string>();
  private running?: Promise<void>;
  private controller = new AbortController();
  private ready = false;
  overview: LearningOverview = { status: 'starting', activeGame: null, processedPlies: 0, totalPlies: 0, caseCount: 0, reviews: [], errors: [] };
  constructor(private userData: string, private publish: (overview: LearningOverview, db?: LearningDatabase) => void = () => {}) { this.library = new LearningLibrary(userData); }
  private emit(db = false) {
    this.overview.caseCount = this.db.cases.length;
    this.overview.reviews = this.db.reviews.map(summarizeReview).slice(0, 30);
    this.publish(structuredClone(this.overview), db ? this.db : undefined);
  }
  private error(message: string) { this.overview.errors = [...this.overview.errors, message].slice(-10); }
  async initialize(): Promise<void> {
    this.db = await this.library.load(); this.ready = true;
    if (this.db.rejected) this.error(`${this.db.rejected} 条磁盘案例未通过重验或重复，未注入模型；原文件及后续写入前的备份保留。`);
    this.overview.status = this.overview.errors.length ? 'error' : 'idle'; this.emit(true);
  }
  async scan(): Promise<void> {
    if (!this.ready) throw new Error('学习库尚未就绪');
    let files: string[] = [];
    try { files = await readdir(path.join(this.userData, 'records')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    for (const file of files.filter(x => x.endsWith('.json')).sort().slice(0, 2000)) {
      const id = file.slice(0, -5); if (validGameId(id)) this.queue.add(id);
    }
    await this.drain();
  }
  enqueue(id: string): Promise<void> {
    if (!validGameId(id)) return Promise.reject(new Error('无效棋局 ID'));
    this.queue.add(id); return this.drain();
  }
  private drain(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.work().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async work(): Promise<void> {
    while (this.queue.size && !this.controller.signal.aborted) {
      const id = this.queue.values().next().value!; this.queue.delete(id);
      try {
        const file = path.join(this.userData, 'records', `${id}.json`);
        if ((await stat(file)).size > 16 * 1024 * 1024) throw new Error('棋谱超过 16MB 上限');
        const record = normalizeRecord(JSON.parse(await readFile(file, 'utf8')));
        if (record.id !== id) throw new Error('文件名与棋局 ID 不一致');
        if (!record.outcome || this.db.reviews.some(x => x.gameId === id && x.fingerprint === recordFingerprint(record))) continue;
        this.overview = { ...this.overview, status: 'reviewing', activeGame: id, processedPlies: 0, totalPlies: record.moves.length }; this.emit();
        const result = await reviewFinishedGame(record, { signal: this.controller.signal, onProgress: (ply) => {
          this.overview.processedPlies = ply; if (ply % 4 === 0 || ply === record.moves.length) this.emit();
        } });
        if (this.controller.signal.aborted) break;
        this.db = await this.library.commit(result); this.emit(true);
      } catch (e) { if (!this.controller.signal.aborted) this.error(`棋局 ${id}：${e instanceof Error ? e.message : String(e)}`); }
    }
    this.overview.status = this.overview.errors.length ? 'error' : 'idle'; this.overview.activeGame = null; this.emit();
  }
  async stop(): Promise<void> { this.controller.abort(); this.queue.clear(); await this.running; }
}
