const { app, BrowserWindow, Menu } = require("electron");
const path = require("node:path");

let window;
function createWindow() {
  window = new BrowserWindow({
    title: "拾伍 · 五子棋",
    width: 1180,
    height: 880,
    minWidth: 880,
    minHeight: 720,
    backgroundColor: "#f5f2ea",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  // Ctrl+Q also quits on macOS, where the app menu only binds Cmd+Q.
  window.webContents.on("before-input-event", (event, input) => {
    if (process.platform === "darwin" && input.type === "keyDown" && input.control && !input.meta && input.key.toLowerCase() === "q") {
      event.preventDefault();
      app.quit();
    }
  });
  window.loadFile(path.join(__dirname, "renderer", "index.html"));
  window.on("closed", () => {
    window = null;
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
      {
        label: "编辑",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "视图",
        submenu: [
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
    ]),
  );
  createWindow();
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});
// Single-window game: closing the window ends the app on every platform, so
// `just five` returns to the shell instead of leaving Electron resident.
app.on("window-all-closed", () => app.quit());
