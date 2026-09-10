import { describe, it, expect } from "vitest";
import {
  piDependencies,
  resolvedVersion,
  distinctVersions,
  installPlan,
} from "../scripts/pi-packages.mjs";

const ROOT_MANIFEST = {
  dependencies: {
    "@earendil-works/pi-coding-agent": "^0.84.1",
    "@earendil-works/pi-tui": "^0.84.1",
    "pi-mcp-adapter": "^2.21.2",
  },
  devDependencies: { "@earendil-works/pi-ai": "^0.84.1", prettier: "^3.0.0" },
};

describe("piDependencies", () => {
  it("finds the pi packages and remembers which section each lives in", () => {
    expect(piDependencies(ROOT_MANIFEST)).toEqual([
      { name: "@earendil-works/pi-ai", section: "devDependencies" },
      { name: "@earendil-works/pi-coding-agent", section: "dependencies" },
      { name: "@earendil-works/pi-tui", section: "dependencies" },
    ]);
  });

  // pi-mcp-adapter is a pi-adjacent package that is NOT in the scope, and is
  // Dependabot's job. Bumping it here would put it under two owners.
  it("leaves unscoped packages alone, pi-mcp-adapter included", () => {
    const names = piDependencies(ROOT_MANIFEST).map((p) => p.name);
    expect(names).not.toContain("pi-mcp-adapter");
    expect(names).not.toContain("prettier");
  });

  // The whole point of deriving this: a fourth pi package should need no edit
  // to the workflow. Hardcoding meant it got bumped by nothing and then flagged
  // as split by the lockstep gate.
  it("picks up a pi package nobody has written down anywhere", () => {
    const withNew = {
      ...ROOT_MANIFEST,
      dependencies: { ...ROOT_MANIFEST.dependencies, "@earendil-works/pi-brand-new": "^0.84.1" },
    };
    expect(piDependencies(withNew).map((p) => p.name)).toContain("@earendil-works/pi-brand-new");
  });

  it("does not fall over on a manifest with no dependencies at all", () => {
    expect(piDependencies({})).toEqual([]);
  });
});

describe("resolvedVersion", () => {
  const lock = { packages: { "node_modules/@earendil-works/pi-ai": { version: "0.84.3" } } };

  // The manifest says ^0.84.1; the lockfile says 0.84.3. Only the second is the
  // version anything actually runs.
  it("reads the resolved version rather than the range floor", () => {
    expect(resolvedVersion(lock, "@earendil-works/pi-ai")).toBe("0.84.3");
  });

  it("returns null for a package the lockfile does not carry", () => {
    expect(resolvedVersion(lock, "@earendil-works/pi-tui")).toBeNull();
  });

  // A nested copy is a different question, and lockstep's to answer.
  it("ignores nested copies", () => {
    const nested = {
      packages: {
        "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai": {
          version: "0.83.0",
        },
      },
    };
    expect(resolvedVersion(nested, "@earendil-works/pi-ai")).toBeNull();
  });
});

describe("distinctVersions", () => {
  it("collapses to one entry when both trees agree", () => {
    expect(
      distinctVersions([
        { packages: [{ version: "0.84.1" }, { version: "0.84.1" }] },
        { packages: [{ version: "0.84.1" }] },
      ]),
    ).toEqual(["0.84.1"]);
  });

  // The scenario the range-floor read missed entirely: root current, app behind.
  // Reading only the root's range reports "nothing to do" while main sits in the
  // exact split state this workflow exists to repair.
  it("reports both versions when the trees have drifted apart", () => {
    expect(
      distinctVersions([
        { packages: [{ version: "0.84.3" }] },
        { packages: [{ version: "0.84.1" }] },
      ]),
    ).toEqual(["0.84.1", "0.84.3"]);
  });

  it("skips packages the lockfile could not resolve", () => {
    expect(distinctVersions([{ packages: [{ version: null }, { version: "0.84.1" }] }])).toEqual([
      "0.84.1",
    ]);
  });
});

describe("installPlan", () => {
  const trees = [
    {
      dir: ".",
      packages: [
        { name: "@earendil-works/pi-ai", section: "devDependencies" },
        { name: "@earendil-works/pi-coding-agent", section: "dependencies" },
        { name: "@earendil-works/pi-tui", section: "dependencies" },
      ],
    },
    { dir: "app", packages: [{ name: "@earendil-works/pi-ai", section: "dependencies" }] },
  ];

  it("groups into one invocation per tree and section, with the right save flag", () => {
    expect(installPlan(trees, "0.85.0")).toEqual([
      {
        dir: ".",
        flag: "--save",
        specs: ["@earendil-works/pi-coding-agent@0.85.0", "@earendil-works/pi-tui@0.85.0"],
      },
      { dir: ".", flag: "--save-dev", specs: ["@earendil-works/pi-ai@0.85.0"] },
      { dir: "app", flag: "--save", specs: ["@earendil-works/pi-ai@0.85.0"] },
    ]);
  });

  // pi-ai is a devDependency at the root and a runtime dependency in app/. The
  // section is read from each manifest, so a package that legitimately moves
  // sections is not quietly moved back on the next run.
  it("follows a package that moves sections instead of forcing it back", () => {
    const moved = [
      { dir: ".", packages: [{ name: "@earendil-works/pi-ai", section: "dependencies" }] },
    ];
    expect(installPlan(moved, "0.85.0")[0].flag).toBe("--save");
  });

  it("emits nothing for a tree with no pi packages", () => {
    expect(installPlan([{ dir: "app", packages: [] }], "0.85.0")).toEqual([]);
  });

  it("pins every package to the one target version", () => {
    const specs = installPlan(trees, "0.85.0").flatMap((p) => p.specs);
    expect(specs.every((s) => s.endsWith("@0.85.0"))).toBe(true);
  });
});
