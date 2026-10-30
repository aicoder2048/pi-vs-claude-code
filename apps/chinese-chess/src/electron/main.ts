import { app, BrowserWindow, dialog, ipcMain, Menu, screen } from 'electron';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiDriver } from '../agent/pi-driver';
import { selectStartupModel } from '../agent/model-selection';
import { GameService, type AgentDriver } from '../business/game-service';
import type { Command, GameRecord, ModelChoice, Reply } from '../shared/types';
import { analyze, inside } from '../business/engine';
import { validGameId } from '../business/learning';
import { LearningCoordinator } from '../learning/coordinator';
import { validateSettings } from '../business/clock';

const here = path.dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | null = null;
let service: GameService;
let learning: LearningCoordinator;
let models: ModelChoice[] = [];
let setupError: string | null = null;
let writes = Promise.resolve();
let autosaveErrorReported = false;
const isSmoke = process.env.CHINESE_CHESS_SMOKE === '1';
const reply = async <T>(fn: () => T | Promise<T>): Promise<Reply<T>> => {
  try { return { ok: true, value: await fn() }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
};
// Serialize atomic record replacement. Every new, undone or extended record gets saved;
// records from different game IDs never overwrite one another.
function autosave(record: GameRecord): void {
  writes = writes.then(async () => {
    const dir = path.join(app.getPath('userData'), 'records');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${record.id}.json`), temp = `${file}.tmp`;
    await writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
    await rename(temp, file);
    if (record.outcome) learning?.enqueue(record.id);
  }).catch(error => {
    console.error('棋谱自动保存失败', error);
    if (!autosaveErrorReported && window && !window.isDestroyed()) {
      autosaveErrorReported = true;
      dialog.showErrorBox('棋谱自动保存失败', '请使用「导出棋谱」另存，或检查应用数据目录的写入权限。');
    }
  });
}
function trusted(event: Electron.IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('不受信任的 IPC 来源');
}
function validCommand(value: unknown): Command {
  if (!value || typeof value !== 'object' || !('type' in value)) throw new Error('无效命令');
  const c = value as Record<string, unknown>;
  if (c.type === 'move' && inside(c.from as any) && inside(c.to as any) && Number.isSafeInteger(c.revision)) return c as unknown as Command;
  if (c.type === 'new' && (c.human === 1 || c.human === 2)) return { type: 'new', human: c.human,
    ...(c.settings === undefined ? {} : { settings: validateSettings(c.settings) }) };
  if (c.type === 'model' && typeof c.provider === 'string' && typeof c.id === 'string' && c.id.length < 300 && c.provider.length < 100) return c as unknown as Command;
  if (['undo', 'retry', 'cancel', 'next-round', 'resign'].includes(String(c.type))) return c as unknown as Command;
  throw new Error('命令参数不合法');
}
async function initialize(): Promise<void> {
  let driver: AgentDriver;
  try {
    if (isSmoke) {
      // Explicit UI-test fixture, never used by a normal app launch.
      models = [{ provider: 'test', id: 'fixture', name: 'UI test fixture (not LLM)' }];
      driver = { async run(port) {
        await new Promise(resolve => setTimeout(resolve, 200));
        if (port.signal.aborted) return;
        // Deliberately use the legacy capture-first move for reproducible
        // animation tests; this fixture is not a chess-strength benchmark.
        const move = analyze(port.state.position).candidates[0];
        port.log('extension', 'UI fixture · move_piece');
        port.commit(move, '仅用于桌面自动化测试的固定应答。');
      } };
    } else {
      const pi = await PiDriver.create(app.getPath('userData'));
      models = await pi.models(); driver = pi;
    }
  } catch (error) {
    setupError = `Pi 初始化失败：${error instanceof Error ? error.message : String(error)}`;
    driver = { async run() { throw new Error(setupError!); } };
  }
  const startup = isSmoke ? { model: models[0] ?? null, error: null } : selectStartupModel(models, process.env.CHINESE_CHESS_MODEL);
  const selected = startup.model;
  if (!setupError) setupError = !models.length
    ? '未发现已认证的 Pi 模型。请运行 pi → /login，或设置相应 API Key，再重新启动本应用。'
    : startup.error;
  learning = new LearningCoordinator(app.getPath('userData'), path.join(here, 'learning-worker.js'));
  service = new GameService(driver, selected, { cases: () => learning.cases });
  let learnedCases = learning.cases;
  learning.subscribe(overview => {
    if (learning.cases !== learnedCases) { learnedCases = learning.cases; service.refreshExperience(); }
    if (window && !window.isDestroyed()) window.webContents.send('chess:learning', overview);
  });
  let savedKey = '';
  service.subscribe(state => {
    if (window && !window.isDestroyed()) window.webContents.send('chess:state', state);
    const key = `${state.id}/${state.revision}`;
    if (key !== savedKey) { savedKey = key; autosave(service.record()); }
  });
  ipcMain.handle('chess:bootstrap', (event) => reply(() => { trusted(event); return { state: service.view(), models, setupError, learning: learning.snapshot() }; }));
  ipcMain.handle('chess:evaluation', (event, id: unknown, ply: unknown) => reply(() => {
    trusted(event);
    if (typeof id !== 'string' || id.length > 100 || typeof ply !== 'number') throw new Error('无效的回看请求');
    return service.evaluation(id, ply);
  }));
  ipcMain.handle('chess:command', (event, raw: unknown) => reply(() => {
    trusted(event);
    const command = validCommand(raw);
    switch (command.type) {
      case 'move': return service.humanMove(command, command.revision);
      case 'new': return service.newGame(command.human, command.settings);
      case 'next-round': return service.nextRound();
      case 'resign': return service.resign();
      case 'undo': return service.undo();
      case 'retry': return service.retry();
      case 'cancel': return service.cancel();
      case 'model': {
        const model = models.find(m => m.provider === command.provider && m.id === command.id);
        if (!model) throw new Error('请选择已配置认证的模型');
        return service.setModel(model);
      }
    }
  }));
  ipcMain.handle('chess:review-game', (event, id: unknown) => reply(() => { trusted(event); if (!validGameId(id)) throw new Error('无效棋局 ID'); return learning.review(id); }));
  ipcMain.handle('chess:rescan-learning', (event) => reply(() => { trusted(event); learning.scan(); return learning.snapshot(); }));
  ipcMain.handle('chess:export', (event) => reply(async () => {
    trusted(event);
    const record = service.record();
    const { canceled, filePath } = await dialog.showSaveDialog(window!, {
      title: '导出完整棋谱与逐手计算', defaultPath: `楚河-${record.id.slice(0, 8)}.json`, filters: [{ name: 'JSON 棋谱', extensions: ['json'] }],
    });
    if (canceled || !filePath) return null;
    await writeFile(filePath, JSON.stringify(record, null, 2), { mode: 0o600 }); return filePath;
  }));
}
function createWindow(): void {
  const area = screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({
    width: Math.min(1280, area.width), height: Math.min(900, area.height),
    minWidth: Math.min(1010, area.width), minHeight: Math.min(700, area.height),
    backgroundColor: '#f2ede2', title: '楚河 · 中国象棋（对弈大模型版）',
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 22, y: 22 },
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  void window.loadFile(path.join(here, '../renderer/index.html'));
  window.on('closed', () => { service?.cancel(); window = null; });
}
app.setName('Chinese Chess LLM');
if (isSmoke) app.setPath('userData', path.join(app.getPath('temp'), `chinese-chess-smoke-${process.pid}`));
// Do not top-level-await app.whenReady(): Electron waits for ESM evaluation
// before emitting ready, so awaiting it at module scope would deadlock startup.
void app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' },
      // Ctrl+Q also quits on macOS, where the role above only binds Cmd+Q.
      ...(process.platform === 'darwin' ? [{ label: '退出', accelerator: 'Ctrl+Q', visible: false, click: () => app.quit() }] : [])] },
    { label: '编辑', submenu: [{ role: 'copy' }, { role: 'selectAll' }] },
    { label: '显示', submenu: [{ role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
  ]));
  await initialize(); createWindow();
}).catch(error => { dialog.showErrorBox('楚河启动失败', String(error)); app.quit(); });
app.on('activate', () => { if (service && BrowserWindow.getAllWindows().length === 0) createWindow(); });
// Single-window game: closing the window ends the app on every platform, so
// `just chinese-chess` returns to the shell instead of leaving Electron resident.
app.on('window-all-closed', () => app.quit());
// Timer runs in the trusted main process, not a throttled/background renderer.
const heartbeat = setInterval(() => service?.tick(), 200);
let exiting = false;
app.on('before-quit', event => {
  if (exiting) return;
  event.preventDefault(); exiting = true; clearInterval(heartbeat);
  if (service) { service.tick(); autosave(service.record()); service.dispose(); }
  // Give queued atomic saves a chance to complete without trapping quit forever.
  void Promise.race([writes.then(() => learning?.close()), new Promise(resolve => setTimeout(resolve, 3000))]).finally(() => app.quit());
});
