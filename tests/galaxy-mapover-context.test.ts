import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// context.ts reads executionMode from loadConfig(); control it so the Galaxy
// block is deterministic regardless of the dev machine's real config.
const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));
vi.mock("../extensions/loom/config", () => ({ loadConfig: loadConfigMock }));

import { buildGalaxyContextBlock } from "../extensions/loom/context";

describe("buildGalaxyContextBlock map-over guidance (#208)", () => {
  let savedUrl: string | undefined;
  let savedKey: string | undefined;

  beforeEach(() => {
    loadConfigMock.mockReset();
    loadConfigMock.mockReturnValue({});
    savedUrl = process.env.GALAXY_URL;
    savedKey = process.env.GALAXY_API_KEY;
    process.env.GALAXY_URL = "https://galaxy.example.org";
    process.env.GALAXY_API_KEY = "fake-key";
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.GALAXY_URL;
    else process.env.GALAXY_URL = savedUrl;
    if (savedKey === undefined) delete process.env.GALAXY_API_KEY;
    else process.env.GALAXY_API_KEY = savedKey;
  });

  it("teaches map-over recovery when a collection hits a single-dataset input", () => {
    const block = buildGalaxyContextBlock();

    // Names the exact Galaxy failure symptom so the model recognizes it.
    expect(block).toContain("map/reduce");
    expect(block).toMatch(/single[ -]input dataset parameter/i);

    // Gives the corrective batch-wrapper shape that actually reaches Galaxy.
    expect(block).toContain("batch");
    expect(block).toContain("values");
    expect(block).toContain("hdca");

    // Breaks the retry-the-same-inputs loop the issue describes.
    expect(block).toMatch(/don'?t retry|do not retry/i);

    // Routes to the authoritative skill for linked/unlinked/nested variants.
    expect(block).toContain("collection-manipulation/SKILL.md");
  });

  it("emits no Galaxy guidance (and thus no map-over text) when disconnected", () => {
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;

    const block = buildGalaxyContextBlock();

    expect(block).toContain("NOT CONNECTED");
    expect(block).not.toContain("map/reduce");
  });

  it("emits nothing in local execution mode", () => {
    loadConfigMock.mockReturnValue({ executionMode: "local" });

    expect(buildGalaxyContextBlock()).toBe("");
  });
});
