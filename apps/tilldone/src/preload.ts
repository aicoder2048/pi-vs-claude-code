/** TillDone Desk L2: sandbox-compatible bridge exposing only intents and JSON view subscriptions. */
import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("tilldone", Object.freeze({
	send: (intent: unknown) => ipcRenderer.invoke("desk:intent", intent),
	onView: (callback: (view: unknown) => void) => {
		const listener = (_event: Electron.IpcRendererEvent, view: unknown) => callback(view);
		ipcRenderer.on("desk:view", listener);
		ipcRenderer.send("desk:subscribe");
		return () => ipcRenderer.removeListener("desk:view", listener);
	},
}));
