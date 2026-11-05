/**
 * A resolvable stand-in for Electron in the root test package.
 *
 * Electron is a dependency of `app/`, not of the root package the tests run
 * from. So `import "electron"` inside `app/src/main/*` resolves to
 * `app/node_modules/electron`, while the `vi.mock("electron")` in a test under
 * `tests/` resolves from the root, where there is nothing to resolve. The two
 * ids disagree, so the factory never replaces the module the code under test
 * actually imported -- and which way that breaks depends on whether `app/`'s
 * dependencies happen to be installed:
 *
 *   - app deps installed (the setup CLAUDE.md documents): the real package
 *     loads. Its entry point exports the path to the Electron binary -- a
 *     string -- so every named import comes back undefined and the first call
 *     through one throws `Cannot read properties of undefined`.
 *   - app deps absent (what the npm publish job installs): nothing resolves.
 *
 * `vitest.config.ts` aliases "electron" to this file so both spellings land on
 * a single id that always resolves. A test that mocks "electron" then really
 * does replace what the module under test imported, in either install state.
 *
 * Nothing here emulates Electron. A test that reaches a real Electron API has
 * a missing mock, so these throw and say so rather than returning a plausible
 * value and failing somewhere less obvious. Tests that only need the import to
 * resolve -- the common case, since most of `app/src/main` imports Electron at
 * module scope and is then exercised through pure functions -- pay nothing.
 */

function unavailable(member: string): never {
  throw new Error(
    `electron.${member} was called in a test. Electron is not running here: ` +
      `mock "electron" with vi.mock in the test that reaches it.`,
  );
}

/** Builds an inert namespace whose every member throws when called. */
function stub<K extends string>(namespace: string, members: readonly K[]): Record<K, () => never> {
  return Object.fromEntries(
    members.map((member) => [member, () => unavailable(`${namespace}.${member}`)]),
  ) as Record<K, () => never>;
}

export const app = {
  // Read as a plain property by secure-config.ts, so it answers rather than
  // throws. False is what an unpackaged dev run reports, which is the state
  // the tests describe.
  isPackaged: false,
  ...stub("app", ["getPath", "getName", "getVersion", "quit", "on", "whenReady", "setName"]),
};

export const ipcMain = stub("ipcMain", ["handle", "removeHandler", "on", "removeAllListeners"]);

export const shell = stub("shell", ["openPath", "openExternal", "showItemInFolder"]);

export const dialog = stub("dialog", ["showOpenDialog", "showSaveDialog", "showMessageBox"]);

export const net = stub("net", ["request", "fetch", "isOnline"]);

export const safeStorage = stub("safeStorage", [
  "isEncryptionAvailable",
  "encryptString",
  "decryptString",
]);

export const autoUpdater = stub("autoUpdater", [
  "setFeedURL",
  "checkForUpdates",
  "quitAndInstall",
  "on",
]);

export const powerMonitor = stub("powerMonitor", ["on", "removeAllListeners"]);

export const contextBridge = stub("contextBridge", ["exposeInMainWorld"]);

export const ipcRenderer = stub("ipcRenderer", ["invoke", "send", "on", "removeAllListeners"]);

export const webUtils = stub("webUtils", ["getPathForFile"]);

export const Menu = stub("Menu", ["buildFromTemplate", "setApplicationMenu"]);

export const nativeTheme = { shouldUseDarkColors: false, ...stub("nativeTheme", ["on"]) };

/** Constructed by main.ts; a test that builds a window needs its own mock. */
export class BrowserWindow {
  constructor() {
    unavailable("BrowserWindow");
  }
  static getAllWindows(): never {
    return unavailable("BrowserWindow.getAllWindows");
  }
  static fromWebContents(): never {
    return unavailable("BrowserWindow.fromWebContents");
  }
}

export type IpcMain = typeof ipcMain;
export type IpcMainInvokeEvent = unknown;
export type WebContents = unknown;
