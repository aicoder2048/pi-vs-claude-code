import { copyFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { LEARNING_VERSION, VALIDATOR_VERSION, validGameId, validateCase, type PostGameReview, type TacticalCase } from '../business/learning';
export interface LearningDatabase { format: typeof LEARNING_VERSION; validator: string; cases: TacticalCase[]; reviews: PostGameReview[]; rejected?: number }
const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 600;
function validReview(r: any): boolean {
  return !!r && r.version === LEARNING_VERSION && r.validator === VALIDATOR_VERSION && validGameId(r.gameId)
    && typeof r.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(r.fingerprint) && count(r.plies)
    && typeof r.completedAt === 'string' && Number.isFinite(Date.parse(r.completedAt))
    && Array.isArray(r.findings) && r.findings.length <= 600 && r.findings.every((f: any) => f && count(f.ply) && f.ply > 0 && f.ply <= r.plies
      && ['human', 'machine'].includes(f.actor) && ['verified-local', 'candidate'].includes(f.status)
      && typeof f.notation === 'string' && typeof f.reason === 'string' && Number.isFinite(f.estimatedNet)
      && Array.isArray(f.refutation) && f.refutation.length <= 12 && f.refutation.every((x: unknown) => typeof x === 'string')
      && (f.alternative === null || typeof f.alternative === 'string') && typeof f.exploited === 'boolean')
    && count(r.metrics?.human?.localErrors) && count(r.metrics?.human?.opportunitiesTaken)
    && count(r.metrics?.machine?.localErrors) && count(r.metrics?.machine?.opportunitiesTaken) && count(r.metrics?.candidates)
    && Array.isArray(r.limitations) && r.limitations.every((x: unknown) => typeof x === 'string');
}
const empty = (): LearningDatabase => ({ format: LEARNING_VERSION, validator: VALIDATOR_VERSION, cases: [], reviews: [] });
export class LearningLibrary {
  readonly directory: string;
  readonly file: string;
  constructor(userData: string) { this.directory = path.join(userData, 'learning'); this.file = path.join(this.directory, 'library.json'); }
  async load(): Promise<LearningDatabase> {
    let raw: any;
    try {
      if ((await stat(this.file)).size > 32 * 1024 * 1024) throw new Error('案例库超过 32MB 上限');
      raw = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (e: any) { if (e.code === 'ENOENT') return empty(); throw new Error(`案例库读取失败，原文件未覆盖：${String(e.message)}`); }
    if (raw.format !== LEARNING_VERSION || !Array.isArray(raw.cases) || raw.cases.length > 500 || !Array.isArray(raw.reviews) || raw.reviews.length > 1000) throw new Error('案例库结构无效，原文件未覆盖');
    const cases: TacticalCase[] = [];
    for (const saved of raw.cases) {
      const checked = validateCase(saved?.seed, { maxMsPerMove: 150, maxNodesPerMove: 15000 });
      if (!checked) continue; // never feed unvalidated disk prose to the model
      const sources = [checked.seed.source, ...(Array.isArray(saved.sources) ? saved.sources : [])].filter(s =>
        s && typeof s.gameId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(s.gameId) && Number.isInteger(s.ply) && s.ply > 0 && s.ply <= 600 && ['human', 'machine'].includes(s.actor) && [1, 2].includes(s.color) && typeof s.exploited === 'boolean');
      checked.sources = [...new Map(sources.map(s => [`${s.gameId}/${s.ply}`, { gameId: s.gameId, ply: s.ply, actor: s.actor, color: s.color, exploited: s.exploited }])).values()].slice(0, 32);
      if (!cases.some(c => c.key === checked.key)) cases.push(checked);
    }
    const reviews = raw.validator === VALIDATOR_VERSION ? raw.reviews.filter(validReview) : [];
    return { ...empty(), cases, reviews, rejected: raw.cases.length - cases.length };
  }
  private async lock(): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true });
    const lockFile = path.join(this.directory, '.write.lock');
    for (let tries = 0; tries < 30; tries++) {
      try {
        const handle = await open(lockFile, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.close();
        return async () => { await unlink(lockFile).catch(() => {}); };
      } catch (e: any) {
        if (e.code !== 'EEXIST') throw e;
        try {
          const owner = JSON.parse(await readFile(lockFile, 'utf8'));
          if (Number.isInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); } catch (error: any) { if (error.code === 'ESRCH') { await unlink(lockFile); continue; } }
          }
        } catch { /* lock may still be being initialized; never steal a live lock */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    throw new Error('案例库正在被另一进程写入，请稍后重试');
  }
  async commit(result: { review: PostGameReview; cases: TacticalCase[] }): Promise<LearningDatabase> {
    if (!validReview(result.review)) throw new Error('复盘报告结构无效，拒绝提交');
    const release = await this.lock(); let temporary = '';
    try {
      const db = await this.load();
      // Re-read under the exclusive lock: CLI and app transactions cannot lose
      // one another's updates. Cases and processed fingerprints commit together.
      for (const raw of result.cases) {
        const c = validateCase(raw.seed, { maxMsPerMove: 150, maxNodesPerMove: 15000 });
        if (!c) throw new Error('提交的案例未通过独立重验');
        const collision = db.cases.find(x => x.id === c.id && x.key !== c.key);
        if (collision) throw new Error('案例标识冲突，拒绝覆盖');
        const old = db.cases.find(x => x.key === c.key);
        if (old) old.sources = [...new Map([...old.sources, ...c.sources].map(s => [`${s.gameId}/${s.ply}`, s])).values()].slice(0, 32);
        else {
          if (db.cases.length >= 500) throw new Error('案例库达到 500 条上限，本次事务未提交；请扩展或整理案例库');
          db.cases.push(c);
        }
      }
      db.reviews = [result.review, ...db.reviews.filter(r => r.gameId !== result.review.gameId)].slice(0, 1000);
      temporary = `${this.file}.${randomUUID()}.tmp`;
      const serialized = JSON.stringify(db, null, 2);
      if (Buffer.byteLength(serialized) > 32 * 1024 * 1024) throw new Error('案例库达到 32MB 上限，本次事务未提交');
      await writeFile(temporary, serialized, { mode: 0o600 });
      await copyFile(this.file, `${this.file}.bak`).catch((e: any) => { if (e.code !== 'ENOENT') throw e; });
      await rename(temporary, this.file); temporary = '';
      return db;
    } finally { if (temporary) await unlink(temporary).catch(() => {}); await release(); }
  }
}
