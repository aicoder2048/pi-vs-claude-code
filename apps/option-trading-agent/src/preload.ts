import { contextBridge, ipcRenderer } from 'electron';
import type { AgentView } from './business/types.ts';
import type { DesktopBridge } from './desktop.ts';

const bridge: DesktopBridge = {
  view: () => ipcRenderer.invoke('option-agent:view'),
  subscribe(listener) {
    const receive = (_event: Electron.IpcRendererEvent, view: AgentView): void => { listener(view); };
    ipcRenderer.on('option-agent:update', receive);
    return () => { ipcRenderer.removeListener('option-agent:update', receive); };
  },
  send: command => ipcRenderer.invoke('option-agent:command', command),
};

contextBridge.exposeInMainWorld('optionAgent', bridge);
