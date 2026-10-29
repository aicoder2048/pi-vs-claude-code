'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { getQuotes, parseTickers } = require('./src/quotes.cjs');

const indexPath = path.join(__dirname, 'renderer', 'index.html');
const indexUrl = pathToFileURL(indexPath).href;
let window;
let pending = null;

function createWindow() {
  window = new BrowserWindow({
    width: 1280, height: 850, minWidth: 880, minHeight: 620,
    title: 'Stock Desk · 股票行情', backgroundColor: '#0c1219',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.loadFile(indexPath);
  window.on('closed', () => { window = null; });
}

app.whenReady().then(() => {
  app.on('web-contents-created', (_event, contents) => {
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
  });
  ipcMain.handle('quotes:fetch', async (event, input) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== indexUrl) {
      return { ok: false, error: '不允许的行情请求来源。' };
    }
    let request;
    try {
      parseTickers(input);
      if (pending) return { ok: false, error: '已有查询正在进行，请稍候。' };
      request = getQuotes(input);
      pending = request;
      return { ok: true, ...await request };
    } catch (error) {
      return { ok: false, error: error.message || '行情查询失败。' };
    } finally {
      if (request && pending === request) pending = null;
    }
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
