import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { loadConfig } from './agent/config.ts';
import { PiDriver } from './agent/driver.ts';
import { parseDesktopCommand, type DesktopReply } from './desktop.ts';

const directory = app.getAppPath();
const outputDirectory = join(directory, 'dist');
const pageURL = pathToFileURL(join(outputDirectory, 'index.html')).href;

async function launch(): Promise<void> {
  const config = loadConfig(directory);
  const profile = app.commandLine.getSwitchValue('user-data-dir') || join(directory, '.local', 'electron');
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }

  const driver = new PiDriver(config);
  let window: BrowserWindow | null = null;
  let shutdown: Promise<void> | null = null;
  let finished = false;
  let publishable = true;
  let unsubscribe = (): void => {};

  function close(): Promise<void> {
    if (shutdown) return shutdown;
    publishable = false;
    shutdown = driver.stop().finally(() => {
      unsubscribe();
      finished = true;
      app.quit();
    });
    return shutdown;
  }

  app.on('before-quit', event => {
    if (finished) return;
    event.preventDefault();
    void close();
  });
  app.on('window-all-closed', () => { void close(); });
  app.on('second-instance', () => {
    if (!window || shutdown) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  function trusted(event: IpcMainInvokeEvent): void {
    if (shutdown || !window || window.isDestroyed() || event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pageURL ||
        event.sender.getURL() !== pageURL) throw new Error('Untrusted desktop sender.');
  }

  ipcMain.handle('option-agent:view', event => { trusted(event); return driver.view(); });
  ipcMain.handle('option-agent:command', async (event, value: unknown): Promise<DesktopReply> => {
    trusted(event);
    try {
      const command = parseDesktopCommand(value);
      switch (command.kind) {
        case 'ask': await driver.ask(command.text); break;
        case 'stop': await driver.stop(); break;
        case 'restart': await driver.restart(); break;
        default: { const exhaustive: never = command; return exhaustive; }
      }
      return { kind: 'ok' };
    } catch (error) {
      return { kind: 'error', error: error instanceof Error ? error.message : 'Desktop command failed.' };
    }
  });

  await app.whenReady();
  if (shutdown) return;
  window = new BrowserWindow({
    title: 'Option trading agent', width: 1240, height: 860, minWidth: 760, minHeight: 620,
    backgroundColor: '#10171e', show: false,
    webPreferences: {
      preload: join(outputDirectory, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webviewTag: false, webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  const contents = window.webContents;
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.on('will-download', event => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-frame-navigate', event => event.preventDefault());
  contents.on('will-redirect', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('render-process-gone', () => { void close(); });
  window.on('close', event => {
    if (finished) return;
    event.preventDefault();
    void close();
  });
  window.on('closed', () => { window = null; });
  window.once('ready-to-show', () => { if (!shutdown) window?.show(); });
  unsubscribe = driver.subscribe(view => { if (publishable && !contents.isDestroyed()) contents.send('option-agent:update', view); });
  await window.loadURL(pageURL);
  if (!shutdown) void driver.start().catch(() => {});
}

void launch().catch(error => {
  const message = error instanceof Error ? error.message : 'Cannot start the desktop.';
  process.stderr.write(`${message}\n`);
  app.exit(1);
});
