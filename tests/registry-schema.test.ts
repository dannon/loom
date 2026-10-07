import { describe, expect, it } from "vitest";
import {
  assertNoDuplicateKeys,
  canonicalJson,
  migrateToCurrent,
  normalizeServerUrl,
  parseRegistry,
  RegistryFormatError,
  specRevision,
  type Registry,
} from "../extensions/loom/registry-schema";
import { eligibleAttempt, HEX, makeSpec, SERVER } from "./registry-fixtures";

function registryWith(over: Partial<Registry> = {}): Record<string, unknown> {
  const a = eligibleAttempt();
  return {
    version: 3,
    revision: 4,
    writer_token: "t",
    session_sig: "",
    analysis_id: "an-1",
    server_url: SERVER,
    attempts: { [a.attempt_id]: a },
    exceptions: [],
    supervision: { active_at_shutdown: [] },
    ...over,
  };
}

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("refuses values JSON cannot carry faithfully", () => {
    expect(() => canonicalJson({ n: NaN })).toThrow();
    expect(() => canonicalJson({ d: new Date(0) })).toThrow();
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
  });

  it("gives equal specs equal revisions regardless of key order", () => {
    const spec = makeSpec();
    const shuffled = JSON.parse(JSON.stringify({ ...spec, target: { ...spec.target } }));
    const reordered = Object.fromEntries(Object.entries(shuffled).reverse());
    expect(specRevision(reordered as typeof spec)).toBe(specRevision(spec));
  });
});

describe("assertNoDuplicateKeys", () => {
  it("passes ordinary JSON, including keys that look alike inside strings", () => {
    expect(() => assertNoDuplicateKeys('{"a":"a","b":["a","a"],"c":{"a":1}}')).not.toThrow();
  });

  it("catches a repeated key, including one spelled with an escape", () => {
    expect(() => assertNoDuplicateKeys('{"a":1,"a":2}')).toThrow(RegistryFormatError);
    expect(() => assertNoDuplicateKeys('{"x":{"id":1,"\\u0069d":2}}')).toThrow(/duplicate/);
  });
});

describe("parseRegistry", () => {
  it("round-trips a valid document", () => {
    const doc = registryWith();
    const parsed = parseRegistry(doc);
    expect(Object.keys(parsed.attempts)).toHaveLength(1);
  });

  it("drops keys the schema doesn't know, at every level", () => {
    const doc = registryWith() as Record<string, any>;
    doc.trusted = true;
    const id = Object.keys(doc.attempts)[0];
    doc.attempts[id].approval.also_live = true;
    doc.attempts[id].evaluation.bonus = "pass";
    const parsed = parseRegistry(doc) as any;
    expect(parsed.trusted).toBeUndefined();
    expect(parsed.attempts[id].approval.also_live).toBeUndefined();
    expect(parsed.attempts[id].evaluation.bonus).toBeUndefined();
  });

  it("never takes handoff_eligible from input", () => {
    const doc = registryWith() as Record<string, any>;
    const id = Object.keys(doc.attempts)[0];
    doc.attempts[id].handoff_eligible = true;
    expect(parseRegistry(doc).attempts[id].handoff_eligible).toBe(false);
  });

  const malformed: Array<[string, (d: Record<string, any>, id: string) => void]> = [
    ["an unknown enum value", (d, id) => (d.attempts[id].evaluation.execution = "mostly")],
    [
      "an attempt keyed under another id",
      (d, id) => (d.attempts[id].attempt_id = "01K5Z" + "0".repeat(21)),
    ],
    [
      "an attempt id that isn't a ULID",
      (d, id) => {
        d.attempts["../../etc"] = { ...d.attempts[id], attempt_id: "../../etc" };
      },
    ],
    [
      "an unpinned Spec",
      (d, id) => (d.attempts[id].approval.spec_snapshot.target.version = "unpinned"),
    ],
    [
      "a vacuous assertions_pass",
      (d, id) => {
        d.attempts[id].approval.spec_snapshot.predicate = { kind: "assertions_pass", ids: [] };
      },
    ],
    [
      "an assertions_pass naming an assertion that isn't frozen",
      (d, id) => {
        d.attempts[id].approval.spec_snapshot.predicate = { kind: "assertions_pass", ids: ["x"] };
      },
    ],
    [
      "a revision that doesn't hash the snapshot",
      (d, id) => (d.attempts[id].approval.spec_revision = HEX("f")),
    ],
    ["a negative revision", (d) => (d.revision = -1)],
    ["a fractional revision", (d) => (d.revision = 1.5)],
    ["a revision too large to keep incrementing", (d) => (d.revision = Number.MAX_SAFE_INTEGER)],
    [
      "duplicate exception ids",
      (d, id) => {
        const ex = {
          id: "e",
          attempt_id: id,
          spec_revision: HEX("1"),
          scope: "evidence_gate",
          by: "user",
          at: "t",
          reason: "r",
        };
        d.exceptions = [ex, { ...ex }];
      },
    ],
    [
      "an assertion_id on an exception that isn't an evidence gate",
      (d, id) => {
        d.exceptions = [
          {
            id: "e",
            attempt_id: id,
            spec_revision: HEX("1"),
            scope: "manual_attestation",
            assertion_id: "build",
            by: "user",
            at: "t",
            reason: "r",
          },
        ];
      },
    ],
    ["an attempt both live and quarantined", (d, id) => (d.quarantine = { [id]: d.attempts[id] })],
    ["a missing supervision block", (d) => delete d.supervision],
  ];
  for (const [name, breakIt] of malformed) {
    it(`rejects ${name}`, () => {
      const doc = registryWith() as Record<string, any>;
      breakIt(doc, Object.keys(doc.attempts)[0]);
      expect(() => parseRegistry(doc)).toThrow(RegistryFormatError);
    });
  }
});

describe("migrations", () => {
  it("passes a current document through untouched", () => {
    const doc = registryWith();
    expect(migrateToCurrent(doc)).toBe(doc);
  });

  it("refuses a document from a newer Loom", () => {
    expect(() => migrateToCurrent(registryWith({ version: 4 as 3 }))).toThrow(/newer Loom/);
  });

  it("refuses an older version with no migration registered", () => {
    expect(() => migrateToCurrent({ ...registryWith(), version: 2 })).toThrow(/no migration/);
  });

  it("runs a registered chain up to the current version", () => {
    const v2 = { ...registryWith(), version: 2, attempt_map: registryWith().attempts };
    delete (v2 as Record<string, unknown>).attempts;
    const migrated = migrateToCurrent(v2, {
      2: ({ attempt_map, ...rest }) => ({ ...rest, version: 3, attempts: attempt_map }),
    });
    expect(Object.keys(parseRegistry(migrated).attempts)).toHaveLength(1);
  });
});

describe("normalizeServerUrl", () => {
  it("treats scheme-less, trailing-slash and case variants as one server", () => {
    expect(normalizeServerUrl("UseGalaxy.example/")).toBe(normalizeServerUrl(SERVER));
  });
});

describe("prototype keys", () => {
  it("rejects __proto__ as an evaluation assertion key or a frozen assertion id", () => {
    const doc = registryWith() as Record<string, any>;
    const id = Object.keys(doc.attempts)[0];
    const text = JSON.stringify(doc).replace(
      '"assertions":{}',
      '"assertions":{"__proto__":"pass"}',
    );
    expect(() => parseRegistry(JSON.parse(text))).toThrow(RegistryFormatError);
    const spec = doc.attempts[id].approval.spec_snapshot;
    spec.assertions = [{ id: "__proto__", definition_digest: HEX("1"), definition: {} }];
    doc.attempts[id].approval.spec_revision = specRevision(spec);
    expect(() => parseRegistry(doc)).toThrow(RegistryFormatError);
  });
});

describe("exceptions", () => {
  it("keeps an evidence gate's assertion_id through a parse", () => {
    const doc = registryWith() as Record<string, any>;
    const id = Object.keys(doc.attempts)[0];
    doc.exceptions = [
      {
        id: "e",
        attempt_id: id,
        spec_revision: HEX("1"),
        scope: "evidence_gate",
        assertion_id: "build",
        by: "user",
        at: "t",
        reason: "r",
      },
    ];
    expect(parseRegistry(doc).exceptions[0].assertion_id).toBe("build");
  });
});

describe("evaluation", () => {
  it("keeps an attested predicate result distinct from pass", () => {
    const doc = registryWith() as Record<string, any>;
    const id = Object.keys(doc.attempts)[0];
    doc.attempts[id].evaluation.predicate_result = "attested";
    expect(parseRegistry(doc).attempts[id].evaluation!.predicate_result).toBe("attested");
  });
});
