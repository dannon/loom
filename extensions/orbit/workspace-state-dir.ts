/**
 * The per-analysis state dir (`<cwd>/.loom/` today, `<cwd>/.orbit/` after the
 * rename). A workspace keeps whichever one it already has -- the conda env
 * under it has hardcoded prefixes and cannot be moved -- so the active name is
 * resolved per workspace, while the exec-guard protects every name in
 * WORKSPACE_STATE_DIR_NAMES no matter which one is active.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const ORBIT_STATE_DIR_NAME = ".orbit";
export const LEGACY_STATE_DIR_NAME = ".loom";

export type WorkspaceStateDirName = typeof ORBIT_STATE_DIR_NAME | typeof LEGACY_STATE_DIR_NAME;

/** Every spelling the security code treats as Orbit state, in resolution order. */
export const WORKSPACE_STATE_DIR_NAMES: readonly WorkspaceStateDirName[] = [
  ORBIT_STATE_DIR_NAME,
  LEGACY_STATE_DIR_NAME,
];

// What a workspace with neither dir gets. Deliberately still `.loom` in the
// rename release: registry.ts, galaxy-provenance and submission capture
// hardcode `.loom/...` and persist relative paths, so flipping this alone would
// split a workspace's state in two. Route those through the resolver first.
export const NEW_WORKSPACE_STATE_DIR_NAME: WorkspaceStateDirName = LEGACY_STATE_DIR_NAME;

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `.orbit` if the workspace has one, else `.loom` if it has that, else the default. */
export function resolveWorkspaceStateDirName(cwd: string): WorkspaceStateDirName {
  for (const name of WORKSPACE_STATE_DIR_NAMES) {
    if (isDir(path.join(cwd, name))) return name;
  }
  return NEW_WORKSPACE_STATE_DIR_NAME;
}

export function resolveWorkspaceStateDir(cwd: string): string {
  return path.join(cwd, resolveWorkspaceStateDirName(cwd));
}
