import { contextBridge, ipcRenderer } from 'electron';
import type { LearningOverview } from '../business/learning';
import type { DesktopAPI, GameState } from '../shared/types';
const api: DesktopAPI = {
  bootstrap: () => ipcRenderer.invoke('chess:bootstrap'),
  command: command => ipcRenderer.invoke('chess:command', command),
  evaluation: (id, ply) => ipcRenderer.invoke('chess:evaluation', id, ply),
  exportRecord: () => ipcRenderer.invoke('chess:export'),
  reviewGame: id => ipcRenderer.invoke('chess:review-game', id),
  rescanLearning: () => ipcRenderer.invoke('chess:rescan-learning'),
  onLearning: listener => {
    const handler = (_event: Electron.IpcRendererEvent, overview: LearningOverview) => listener(overview);
    ipcRenderer.on('chess:learning', handler);
    return () => ipcRenderer.removeListener('chess:learning', handler);
  },
  onState: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: GameState) => listener(state);
    ipcRenderer.on('chess:state', handler);
    return () => ipcRenderer.removeListener('chess:state', handler);
  },
};
contextBridge.exposeInMainWorld('chess', api);
