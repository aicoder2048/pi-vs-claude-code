import os from 'node:os';
import path from 'node:path';
import { LearningRunner } from '../src/learning/runner';
const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support')
  : process.platform === 'win32' ? process.env.APPDATA ?? path.join(os.homedir(), 'AppData/Roaming')
  : process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
const dataDir = process.argv[2] || path.join(base, 'Chinese Chess LLM');
console.log(`本地复盘目录：${dataDir}（不联网，不修改原棋谱）`);
let last = '';
const runner = new LearningRunner(dataDir, overview => {
  const key = `${overview.status}/${overview.activeGame}`;
  if (key !== last) { last = key; console.log(`${overview.status} ${overview.activeGame ?? ''} · 已验证案例 ${overview.caseCount}`); }
});
try { await runner.initialize(); await runner.scan(); console.log(JSON.stringify(runner.overview, null, 2)); if (runner.overview.errors.length) process.exitCode = 1; }
catch (e) { console.error(String(e)); process.exitCode = 1; }
finally { await runner.stop(); }
