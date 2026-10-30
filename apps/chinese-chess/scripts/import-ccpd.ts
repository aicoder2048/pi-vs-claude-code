// Explicit maintenance command only. Normal builds/starts never fetch data.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseOpeningPgn } from '../src/business/pgn';
const commit = '368a47a947773dd8692c026e286dd19b6277b993';
const root = `https://raw.githubusercontent.com/Yvonne761/Chinese-Chess-Practical-Dataset/${commit}/`;
const hash = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
async function get(path: string): Promise<Uint8Array> {
  const response = await fetch(root + path.split('/').map(encodeURIComponent).join('/'), { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`);
  const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.length > 100000) throw new Error('文件超过导入上限'); return bytes;
}
const licenseBytes = await get('LICENSE'), license = new TextDecoder().decode(licenseBytes);
if (!license.includes('Creative Commons Attribution 4.0') || !license.includes('Yu-Han Tseng')) throw new Error('许可声明与审计预期不符，拒绝导入');
const lines: any[] = [], rejected: any[] = [];
// Fixed, reproducible subset; no full-dataset mirroring. Validate the entire
// imported prefix, not the unimported remainder of the upstream game.
for (let i = 1; i <= 64; i++) {
  const path = `Dataset/開局/${String(i).padStart(8, '0')}.pgn`, bytes = await get(path);
  try {
    const parsed = parseOpeningPgn(new TextDecoder('big5', { fatal: true }).decode(bytes), 20);
    lines.push({ id: `ccpd-${String(i).padStart(8, '0')}`, ...parsed, path, sha256: hash(bytes) });
  } catch (error) { rejected.push({ path, sha256: hash(bytes), reason: String(error instanceof Error ? error.message : error) }); }
}
await mkdir('src/data/ccpd', { recursive: true });
await writeFile('src/data/ccpd/UPSTREAM-LICENSE.txt', licenseBytes);
const pack = { format: 'ccpd-openings/v1', license: 'CC-BY-4.0', attribution: 'Yu-Han Tseng and Bo-Nian Chen (2026), Chinese Chess Practical Dataset (CCPD)',
  repository: 'https://github.com/Yvonne761/Chinese-Chess-Practical-Dataset', commit, licenseSha256: hash(licenseBytes),
  modifications: 'Selected first 64 opening files; decoded Big5; retained only first 20 plies; converted Chinese notation into validated A0–I9 coordinates. No evaluation/win-rate claims imported.', lines, rejected };
await writeFile('src/data/ccpd/openings.json', JSON.stringify(pack, null, 2) + '\n');
console.log(`CCPD ${commit}: accepted ${lines.length}, rejected ${rejected.length}`);
