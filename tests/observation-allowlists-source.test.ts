import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allOperations } from "@galaxyproject/galaxy-ops";

import { GALAXY_MCP_TOOLS } from "../extensions/loom/observation-allowlists";
import { GALAXY_ALLOWLIST_EXTRA_NAMES } from "../scripts/galaxy-allowlist-extra-names.mjs";

// observation-allowlists.ts is generated, so nothing else notices when the
// installed galaxy-ops gains or loses an operation and the file was not
// regenerated: the new name would just be dropped from every observation.

const ROOT = join(__dirname, "..");

describe("the generated Galaxy tool allowlist", () => {
  const generated = [...GALAXY_MCP_TOOLS];
  // allOperations is shared with the browser entry, so read it once, here.
  const operations = [...allOperations].map((op) => op.name);

  it("is galaxy-ops' operations plus the extra names, in the wire spelling", () => {
    expect(generated.every((name) => name.startsWith("galaxy_"))).toBe(true);
    const names = generated.map((name) => name.replace(/^galaxy_/, "")).sort();
    expect(names).toEqual([...new Set([...operations, ...GALAXY_ALLOWLIST_EXTRA_NAMES])].sort());
  });

  it("holds only names galaxy-ops lacks in the extra list", () => {
    expect(GALAXY_ALLOWLIST_EXTRA_NAMES.filter((name) => operations.includes(name))).toEqual([]);
  });

  it("names the installed galaxy-ops in its header", () => {
    const { version } = JSON.parse(
      readFileSync(join(ROOT, "node_modules/@galaxyproject/galaxy-ops/package.json"), "utf-8"),
    ) as { version: string };
    const source = readFileSync(join(ROOT, "extensions/loom/observation-allowlists.ts"), "utf-8");
    expect(source).toContain(`@galaxyproject/galaxy-ops ${version}, allOperations (Node entry)`);
  });
});
