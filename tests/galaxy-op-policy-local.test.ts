import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setGalaxyTransport } from "../extensions/orbit/galaxy-api";
import { GALAXY_OP_POLICY } from "../extensions/orbit/galaxy-op-policy";
import {
  LOCAL_GALAXY_OP_POLICY,
  downloadDestination,
} from "../extensions/orbit/galaxy-op-policy-local";
import { createGalaxyOpsToolSource } from "../extensions/orbit/galaxy-ops-tools";
import {
  registerGalaxyTools,
  setGalaxyToolSource,
  type GalaxyTool,
} from "../extensions/orbit/galaxy-tool-source";
import { json, recordGalaxy } from "./galaxy-test-helpers";

const DATASET = "041fcf44f117cefa";
const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-download-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  setGalaxyTransport(null);
  setGalaxyToolSource(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const dataset = () =>
  recordGalaxy(({ path }) =>
    path.endsWith("/display")
      ? new Response("ACGT\n")
      : json({ id: DATASET, state: "ok", file_ext: "fastqsanger", name: "reads" }),
  );

const download = (tool: GalaxyTool, filePath: string) =>
  tool.execute(
    "c1",
    { dataset_id: DATASET, file_path: filePath },
    undefined,
    undefined,
    {} as never,
  );

const localTool = () =>
  createGalaxyOpsToolSource({ policies: LOCAL_GALAXY_OP_POLICY })
    .tools()
    .find((t) => t.name === "download_dataset")!;

// #647: galaxy-ops' bare writeFile failed with an ENOENT on the file when its directory was
// missing, which reads like the dataset is the problem.
describe("download_dataset destination", () => {
  it("creates file_path's missing parent directories and writes the file", async () => {
    dataset();
    const target = join(scratch(), ".orbit", "tmp", "reads.fastqsanger");
    const result = await download(localTool(), target);
    expect(result.isError).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("ACGT\n");
  });

  it("refuses before asking Galaxy, naming the directory, when it can't be made", async () => {
    const seen = dataset();
    const blocker = join(scratch(), "not-a-dir");
    writeFileSync(blocker, "");
    const result = await download(localTool(), join(blocker, "reads.fastqsanger"));
    expect(seen).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ success: false, errorKind: "validation" });
    expect(result.structuredContent.message).toContain(`directory ${blocker} does not exist`);
  });

  it.each(["~/reads.fastqsanger", "$HOME/data/reads.fastqsanger", "${HOME}/reads.fastqsanger"])(
    "refuses %s rather than making a literal ./~ the exec guard never checked",
    async (filePath) => {
      const seen = dataset();
      const result = await download(localTool(), filePath);
      expect(seen).toEqual([]);
      expect(result.structuredContent).toMatchObject({ success: false, errorKind: "validation" });
      expect(result.structuredContent.message).toContain("absolute or workspace-relative");
      for (const dir of ["~", "$HOME", "${HOME}"]) expect(existsSync(dir)).toBe(false);
    },
  );

  it("leaves a metadata-only download alone", async () => {
    expect(await downloadDestination({ dataset_id: DATASET })).toBeUndefined();
  });

  it("keeps every brain policy and is what the default registration uses", async () => {
    for (const [name, policy] of Object.entries(GALAXY_OP_POLICY))
      expect(LOCAL_GALAXY_OP_POLICY[name]).toBe(policy);
    const tools: GalaxyTool[] = [];
    registerGalaxyTools({
      registerTool: (t: GalaxyTool) => tools.push(t),
    } as unknown as ExtensionAPI);
    dataset();
    const target = join(scratch(), "nested", "reads.fastqsanger");
    const result = await download(
      tools.find((t) => t.name === "download_dataset")!,
      target,
    );
    expect(result.isError).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("ACGT\n");
  });
});
