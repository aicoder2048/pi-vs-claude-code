/** TillDone Desk L2: Electron lifecycle, trusted-frame IPC, and view delivery. No domain rules. */
import { app, BrowserWindow, clipboard, ipcMain, nativeTheme, shell } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.ts";
import { Desk } from "./desk.ts";
import { parsePreferences } from "./appearance.ts";
import { PiCredentials, piAuthPath } from "./credentials.ts";

const appDirectory = app.getAppPath();
const indexPath = resolve(appDirectory, "renderer/index.html");
const indexUrl = pathToFileURL(indexPath).href;
// Reject forbidden billing routes before ready, window creation, or child spawn.
let config: ReturnType<typeof loadConfig>;
try { config = loadConfig(appDirectory); }
catch (error) { console.error(String(error)); app.exit(1); throw error; }

let window: BrowserWindow | null = null;
let quitting = false;
const preferencesPath = resolve(app.getPath("userData"), "appearance.json");
const readPreferences = () => {
	try { return parsePreferences(JSON.parse(readFileSync(preferencesPath, "utf8"))); }
	catch { return undefined; }
};
let desk: Desk;
function createDesk(credentials: PiCredentials): Desk {
	return new Desk(config, (view) => {
		if (window && !window.isDestroyed()) {
			if (window.getTitle() !== view.ui.productName) window.setTitle(view.ui.productName);
			if (!window.webContents.isLoadingMainFrame()) window.webContents.send("desk:view", view);
		}
	}, {
		credentials, openExternal: (url) => shell.openExternal(url), writeClipboard: (text) => clipboard.writeText(text),
		preferences: readPreferences(), systemDark: nativeTheme.shouldUseDarkColors,
		savePreferences: (preferences) => {
			mkdirSync(app.getPath("userData"), { recursive: true });
			writeFileSync(preferencesPath, JSON.stringify(preferences) + "\n", { mode: 0o600 });
		},
	});
}
nativeTheme.on("updated", () => desk?.setSystemDark(nativeTheme.shouldUseDarkColors));
function trusted(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
	return Boolean(window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === indexUrl);
}
function createWindow(): void {
	window = new BrowserWindow({
		width: 1280, height: 850, minWidth: 880, minHeight: 620,
		title: desk.view().ui.productName, backgroundColor: "#10151c",
		webPreferences: { preload: resolve(appDirectory, "dist/preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false },
	});
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	window.webContents.on("will-navigate", (event) => event.preventDefault());
	window.webContents.on("will-attach-webview", (event) => event.preventDefault());
	// Ctrl+Q also quits on macOS, where the default app menu only binds Cmd+Q.
	// Ctrl+V also pastes there, as in terminal agents, so a copied screenshot can be pasted either way.
	window.webContents.on("before-input-event", (event, input) => {
		if (process.platform !== "darwin" || input.type !== "keyDown" || !input.control || input.meta) return;
		const key = input.key.toLowerCase();
		if (key === "q") { event.preventDefault(); app.quit(); }
		if (key === "v") { event.preventDefault(); window?.webContents.paste(); }
	});
	void window.loadFile(indexPath);
	window.on("closed", () => { window = null; });
}
app.whenReady().then(() => {
	const credentials = new PiCredentials(piAuthPath(config.cwd));
	desk = createDesk(credentials);
	app.on("web-contents-created", (_event, contents) => {
		contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		contents.session.setPermissionCheckHandler(() => false);
	});
	ipcMain.on("desk:subscribe", (event) => { if (trusted(event)) event.sender.send("desk:view", desk.view()); });
	ipcMain.handle("desk:intent", async (event, intent: unknown) => {
		if (!trusted(event)) return { ok: false, error: "Untrusted IPC source." };
		try { await desk.send(intent); return { ok: true }; }
		catch (error) { return { ok: false, error: String(error) }; }
	});
	createWindow();
	desk.start();
	app.on("activate", () => { if (!window) createWindow(); });
}).catch((error) => { console.error(error); app.quit(); });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
	if (quitting) return;
	event.preventDefault(); quitting = true;
	void (desk?.stop() ?? Promise.resolve()).finally(() => app.quit());
});
