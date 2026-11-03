/**
 * The op policies that touch the local filesystem, kept out of galaxy-op-policy.ts so the hot path
 * stays Node-free. Only galaxy-ops' Node entry has the ops these cover, so the browser loses
 * nothing by not having them.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { GALAXY_OP_POLICY, type GalaxyOpArgs, type GalaxyOpPolicy } from "./galaxy-op-policy";

// galaxy-ops writes file_path with a bare writeFile, so a missing parent came back as an ENOENT
// on the file itself, which reads like the dataset is missing. The exec guard has already ruled
// on the path by the time this runs, and a relative path resolves against the same cwd the
// write does.
export async function downloadDestination(args: GalaxyOpArgs): Promise<string | undefined> {
  const filePath = args.file_path;
  if (typeof filePath !== "string" || filePath.length === 0) return undefined;
  const dir = dirname(filePath);
  try {
    await mkdir(dir, { recursive: true });
    return undefined;
  } catch (error) {
    const why = (error as { code?: unknown }).code ?? (error as Error).message;
    return (
      `Refused: file_path's directory ${dir} does not exist and could not be created ` +
      `(${String(why)}). Nothing was downloaded. Choose a file_path whose directory exists or ` +
      `can be created.`
    );
  }
}

/** GALAXY_OP_POLICY plus the checks that need a local filesystem. */
export const LOCAL_GALAXY_OP_POLICY: Record<string, GalaxyOpPolicy> = {
  ...GALAXY_OP_POLICY,
  download_dataset: { check: downloadDestination },
};
