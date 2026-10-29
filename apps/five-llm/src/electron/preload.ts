import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, GameState } from '../shared/types';
const api: DesktopAPI = {
  bootstrap: () => ipcRenderer.invoke('five:bootstrap'),
  command: command => ipcRenderer.invoke('five:command', command),
  exportRecord: () => ipcRenderer.invoke('five:export'),
  onState: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: GameState) => listener(state);
    ipcRenderer.on('five:state', handler);
    return () => ipcRenderer.removeListener('five:state', handler);
  },
};
contextBridge.exposeInMainWorld('five', api);
