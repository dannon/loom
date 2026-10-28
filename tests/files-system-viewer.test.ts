import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { handlers, openPath } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  openPath: vi.fn(),
}));
// Electron is installed under app/, not the root test package.
vi.mock("../app/node_modules/electron/index.js", () => ({
  BrowserWindow: {},
  shell: { openPath },
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, listener: (...args: unknown[]) => unknown) =>
      handlers.set(channel, listener),
  },
}));

import { registerFilesIpc } from "../app/src/main/files-handler.js";

let cwd: string;
let outside: string;
const open = (relPath: unknown) => handlers.get("files:open-system-viewer")!(null, relPath);

beforeEach(async () => {
  cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "orbit-system-viewer-"));
  outside = await fsp.mkdtemp(path.join(os.tmpdir(), "orbit-outside-"));
  openPath.mockReset().mockResolvedValue("");
  registerFilesIpc(() => cwd);
});

afterEach(async () => {
  await fsp.rm(cwd, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});

describe("system viewer IPC", () => {
  it("opens a PDF above the preview limit by path, including spaces and metacharacters", async () => {
    const name = "STAGE TWO $(report).pdf";
    const file = path.join(cwd, name);
    await fsp.writeFile(file, "%PDF-1.4\n");
    await fsp.truncate(file, 7_649_365);

    expect(await handlers.get("files:read")!(null, name)).toMatchObject({
      ok: false,
      size: 7_649_365,
      error: expect.stringContaining("File too large"),
    });
    expect(await open(name)).toEqual({ opened: true });
    expect(openPath).toHaveBeenCalledExactlyOnceWith(await fsp.realpath(file));
  });

  it("sends HTML to the default system app as well", async () => {
    await fsp.writeFile(path.join(cwd, "report.html"), "<h1>Report</h1>");
    expect(await open("report.html")).toEqual({ opened: true });
    expect(openPath).toHaveBeenCalledExactlyOnceWith(
      await fsp.realpath(path.join(cwd, "report.html")),
    );
  });

  it("refuses traversal and absolute paths outside the workspace", async () => {
    const file = path.join(outside, "outside.pdf");
    await fsp.writeFile(file, "outside");
    for (const candidate of [path.relative(cwd, file), file]) {
      expect(await open(candidate)).toMatchObject({
        opened: false,
        error: expect.stringContaining("Path escapes working directory"),
      });
    }
    expect(openPath).not.toHaveBeenCalled();
  });

  it("refuses symlinks escaping the workspace, including through parent directories", async () => {
    await fsp.writeFile(path.join(outside, "outside.pdf"), "outside");
    await fsp.symlink(outside, path.join(cwd, "linked"), "junction");
    expect(await open("linked/outside.pdf")).toMatchObject({ opened: false });
    expect(openPath).not.toHaveBeenCalled();
  });

  it("allows a symlink whose target stays within the workspace", async () => {
    await fsp.mkdir(path.join(cwd, "reports"));
    await fsp.writeFile(path.join(cwd, "reports/report.pdf"), "report");
    await fsp.symlink(path.join(cwd, "reports"), path.join(cwd, "linked"), "junction");
    expect(await open("linked/report.pdf")).toEqual({ opened: true });
    expect(openPath).toHaveBeenCalledExactlyOnceWith(
      await fsp.realpath(path.join(cwd, "reports/report.pdf")),
    );
  });

  it("refuses directories, missing files and malformed requests", async () => {
    for (const candidate of [".", "missing.pdf", "", null, 42, {}]) {
      expect(await open(candidate)).toMatchObject({ opened: false, error: expect.any(String) });
    }
    expect(openPath).not.toHaveBeenCalled();
  });

  it("reports both OS refusal strings and rejected opener calls", async () => {
    await fsp.writeFile(path.join(cwd, "report.pdf"), "report");
    openPath.mockResolvedValueOnce("No application is associated with this file");
    expect(await open("report.pdf")).toEqual({
      opened: false,
      error: "No application is associated with this file",
    });
    openPath.mockRejectedValueOnce(new Error("Viewer unavailable"));
    expect(await open("report.pdf")).toEqual({ opened: false, error: "Viewer unavailable" });
  });
});
