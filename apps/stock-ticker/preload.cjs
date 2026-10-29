'use strict';

const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('stockDesk', Object.freeze({
  fetchQuotes: (input) => ipcRenderer.invoke('quotes:fetch', input),
}));
