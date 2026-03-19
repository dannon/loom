import { app, BrowserWindow, Menu, dialog } from "electron";
import { mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { registerIpcHandlers } from "./ipc-handlers.js";
import { AgentManager } from "./agent.js";

const GXYPI_DIR = path.join(os.homedir(), ".gxypi");
const LOG_FILE = path.join(GXYPI_DIR, "debug.log");
const WINDOW_STATE_FILE = path.join(GXYPI_DIR, "window-state.json");

const DEBUG = process.argv.includes("--debug") || !!process.env.GXYPI_DEBUG;

function debugLog(...args: unknown[]): void {
  if (!DEBUG) return;
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`;
  try { appendFileSync(LOG_FILE, line); } catch {}
}

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

function loadWindowState(): WindowState {
  try {
    const data = readFileSync(WINDOW_STATE_FILE, "utf-8");
    const state = JSON.parse(data) as WindowState;
    if (state.width > 0 && state.height > 0) return state;
  } catch {}
  return { width: 1200, height: 800 };
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const bounds = win.getBounds();
    writeFileSync(WINDOW_STATE_FILE, JSON.stringify(bounds));
  } catch {}
}

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

function log(...args: unknown[]): void {
  console.log("[main]", ...args);
}

const DEFAULT_CWD = path.join(os.homedir(), ".gxypi", "analyses");

let mainWindow: BrowserWindow | null = null;
let agentManager: AgentManager | null = null;

function getDefaultCwd(): string {
  const cwd = process.env.GXYPI_CWD || DEFAULT_CWD;
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

function createWindow(cwd: string): void {
  log("creating window, cwd:", cwd);
  const saved = loadWindowState();

  mainWindow = new BrowserWindow({
    ...saved,
    minWidth: 700,
    minHeight: 500,
    title: "gxypi",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }

  agentManager = new AgentManager(mainWindow, cwd);
  registerIpcHandlers(agentManager);

  // Pipe renderer console to file for debugging
  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    const prefix = ["LOG", "WARN", "ERR"][level] || "?";
    debugLog(`[renderer:${prefix}] ${message} (${sourceId}:${line})`);
  });

  mainWindow.webContents.once("did-finish-load", () => {
    debugLog("renderer did-finish-load, starting agent");
    log("renderer loaded, starting agent");
    agentManager!.start();
  });

  mainWindow.on("close", () => {
    if (mainWindow) saveWindowState(mainWindow);
  });

  mainWindow.on("closed", () => {
    log("window closed");
    mainWindow = null;
  });
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "gxypi",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "Open Analysis Directory...",
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            if (!agentManager) return;
            const result = await dialog.showOpenDialog({
              title: "Choose analysis directory",
              defaultPath: agentManager.getCwd(),
              properties: ["openDirectory", "createDirectory"],
            });
            if (result.canceled || result.filePaths.length === 0) return;
            log("switching cwd to:", result.filePaths[0]);
            agentManager.setCwd(result.filePaths[0]);
            agentManager.stop();
            agentManager.start();
          },
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Sidebar",
          accelerator: "CmdOrCtrl+B",
          click: () => mainWindow?.webContents.send("view:toggle-sidebar"),
        },
        { type: "separator" },
        { role: "toggleDevTools" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "gxypi Documentation",
          click: () => {
            import("electron").then(({ shell }) => {
              shell.openExternal("https://github.com/galaxyproject/gxypi");
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  debugLog("app ready");
  log("app ready");
  buildMenu();

  const cwd = getDefaultCwd();
  log("cwd:", cwd);
  createWindow(cwd);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(cwd);
    }
  });
});

app.on("window-all-closed", () => {
  log("all windows closed");
  agentManager?.stop();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  log("before-quit");
  agentManager?.stop();
});
