import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RegistryStore, specRevision, canonicalJson, sha256Hex } from "../extensions/loom/registry";
import {
  approveProposal,
  canonicalizeProposal,
  findDrift,
  newProposalId,
  parseProposalFields,
  pendingProposals,
  PROPOSAL_ID_RE,
  renderProposalTable,
  revokeDrifted,
  revokeProposal,
  templateShape,
  validateProposal,
  type Proposal,
  type ProposalSighting,
} from "../extensions/loom/registry-proposal";
import { SERVER, T0, tmpAnalysisDir } from "./registry-fixtures";
import {
  TOOL_SNAPSHOT,
  UDT_SNAPSHOT,
  UDT_UUID,
  WORKFLOW_SNAPSHOT,
  toolProposal,
} from "./registry-proposal-fixtures";

let dir: string;
let now: number;
const clock = () => now;
const NOW = "2026-10-07T12:00:00.000Z";

function store(sessionId = "s-a", serverUrl = SERVER): RegistryStore {
  const s = new RegistryStore({ analysisDir: dir, serverUrl, sessionId, fs, clock, pid: 100 });
  s.open();
  return s;
}

function approve(s: RegistryStore, proposal: Proposal, snapshot = TOOL_SNAPSHOT) {
  return approveProposal(s, { proposal, snapshot, assertionDefinitions: new Map(), now: NOW });
}

const seen = (p: Proposal | null, id = p?.proposalId ?? "prop-abc123"): ProposalSighting => ({
  proposalId: id,
  proposal: p,
});

beforeEach(() => {
  dir = tmpAnalysisDir();
  now = T0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("proposal validated against the template (v3 §13)", () => {
  const shape = templateShape("tool", TOOL_SNAPSHOT);

  it("accepts a proposal that names real slots and parameters", () => {
    expect(validateProposal(toolProposal(), shape)).toEqual([]);
  });

  it("refuses a slot the template doesn't have, and lists the real ones", () => {
    const problems = validateProposal(
      toolProposal({
        inputs: [
          { slot: "reads", src: "hda", id: "a1" },
          { slot: "fastq", src: "hda", id: "a2" },
        ],
      }),
      shape,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/"fastq" is not a dataset input/);
    expect(problems[0]).toMatch(/reads \(Reads\)/);
  });

  it("refuses when a required input is missing", () => {
    const problems = validateProposal(toolProposal({ inputs: [] }), shape);
    expect(problems).toEqual([
      expect.stringMatching(/required input "reads" \(Reads\) is not given/),
    ]);
  });

  it("refuses a parameter name the template doesn't have", () => {
    const problems = validateProposal(
      toolProposal({ overrides: [{ param: "thread", value: 4, rationale: "typo" }] }),
      shape,
    );
    expect(problems).toEqual([expect.stringMatching(/"thread" is not a parameter of this tool/)]);
  });

  it("reads nested parameters in Galaxy's flat form, with repeat indices", () => {
    const ok = toolProposal({
      overrides: [
        { param: "filter_options|length_required", value: 30, rationale: "short reads" },
        { param: "single_paired|single_paired_selector", value: "single", rationale: "SE run" },
        { param: "queries_2|tag", value: "x", rationale: "third repeat" },
      ],
    });
    expect(validateProposal(ok, shape)).toEqual([]);
  });

  it("does not require a dataset inside a conditional or an optional one", () => {
    // in1/in2 live in a conditional; adapters and pool are optional.
    const s = templateShape("tool", TOOL_SNAPSHOT);
    expect(s.slots.get("single_paired|in1")?.required).toBe(false);
    expect(s.slots.get("adapters")?.required).toBe(false);
    expect(s.slots.get("reads")?.required).toBe(true);
  });

  it("refuses a collection given to a dataset slot, and the reverse", () => {
    const problems = validateProposal(
      toolProposal({
        inputs: [
          { slot: "reads", src: "hdca", id: "c1" },
          { slot: "pool", src: "hda", id: "d1" },
        ],
      }),
      shape,
    );
    expect(problems).toEqual([
      expect.stringMatching(/"reads" takes a dataset/),
      expect.stringMatching(/"pool" takes a collection/),
    ]);
  });

  it("refuses a dataset input passed as an override, and a duplicate override", () => {
    const problems = validateProposal(
      toolProposal({
        overrides: [
          { param: "reads", value: "x", rationale: "r" },
          { param: "threads", value: 1, rationale: "r" },
          { param: "threads", value: 2, rationale: "r" },
        ],
      }),
      shape,
    );
    expect(problems).toEqual([
      expect.stringMatching(/"reads" is a dataset input/),
      expect.stringMatching(/"threads" is overridden twice/),
    ]);
  });

  it("refuses a pinned version Galaxy didn't give", () => {
    const problems = validateProposal(
      toolProposal({ target: { kind: "tool", tool_id: "fastp", version: "0.20.1" } }),
      shape,
    );
    expect(problems).toEqual([expect.stringMatching(/version 0.20.1 was asked for/)]);
  });

  it("reads workflow slots by step index and canonicalizes a unique label", () => {
    const wf = templateShape("workflow", WORKFLOW_SNAPSHOT);
    const p = canonicalizeProposal(
      toolProposal({
        target: { kind: "workflow", workflow_id: "f2db41e1fa331b3e", version: "unpinned" },
        inputs: [
          { slot: "forward", src: "hda", id: "a1" },
          { slot: "1", src: "hdca", id: "c1" },
        ],
        overrides: [{ param: "min length", value: 20, rationale: "short amplicons" }],
      }),
      wf,
    );
    expect(p.inputs.map((i) => i.slot)).toEqual(["0", "1"]);
    expect(p.overrides[0].param).toBe("2");
    expect(validateProposal(p, wf)).toEqual([]);
    const missing = validateProposal({ ...p, inputs: [p.inputs[0]] }, wf);
    expect(missing).toEqual([expect.stringMatching(/required input "1" \(samples\)/)]);
  });

  it("reads a user-defined tool's inputs from its representation", () => {
    const udt = templateShape("udt", UDT_SNAPSHOT);
    expect([...udt.slots.keys()]).toEqual(["table"]);
    expect(udt.params.has("skip")).toBe(true);
  });
});

describe("parsing the block's fields", () => {
  const raw: Record<string, string> = {
    proposal_id: "prop-abc123",
    step_anchor: "plan-a-step-1",
    target: '{"kind":"tool","tool_id":"cat1"}',
    server_url: SERVER,
    history_id: "h1",
    inputs: '[{"slot":"input1","src":"hda","id":"d1"}]',
    overrides: "[]",
    predicate: '{"kind":"manual"}',
  };

  it("reads a minimal block, defaulting version to unpinned and assertions to none", () => {
    const { proposal, errors } = parseProposalFields((k) => raw[k]);
    expect(errors).toEqual([]);
    expect(proposal?.target).toEqual({ kind: "tool", tool_id: "cat1", version: "unpinned" });
    expect(proposal?.assertions).toEqual([]);
  });

  it("ignores unknown keys and never reads a spec_revision", () => {
    const { proposal } = parseProposalFields(
      (k) => ({ ...raw, from_the_future: "x", spec_revision: "f".repeat(64) })[k],
    );
    expect(proposal).not.toBeNull();
    expect(JSON.stringify(proposal)).not.toContain("ffff");
  });

  it("says what is wrong instead of returning a half-read proposal", () => {
    const { proposal, errors } = parseProposalFields(
      (k) =>
        ({
          ...raw,
          target: '{"kind":"tool","workflow_id":"x"}',
          overrides: '[{"param":"p","value":1}]',
        })[k],
    );
    expect(proposal).toBeNull();
    expect(errors).toEqual([
      expect.stringMatching(/target.tool_id is required/),
      expect.stringMatching(/needs a rationale/),
    ]);
  });
});

describe("approve freezes and hashes (v3 §13)", () => {
  it("records a live user approval on a fresh attempt, with the template frozen", () => {
    const s = store();
    const result = approve(s, toolProposal());
    if (!result.ok) throw new Error(result.problems.join("; "));
    const a = s.snapshot().attempts[result.attemptId];
    expect(a.approval).toMatchObject({
      proposal_id: "prop-abc123",
      status: "live",
      by: "user",
      spec_revision: result.specRevision,
    });
    expect(a.binding.step_anchor).toBe("plan-a-step-1");
    // Unpinned resolves to what Galaxy said.
    expect(a.approval?.spec_snapshot.target.version).toBe("0.23.4+galaxy0");
    expect(result.specRevision).toBe(specRevision(result.spec));
    // The template body is on disk under its digest, exactly.
    const digest = result.spec.template_ref.digest;
    expect(digest).toBe(sha256Hex(canonicalJson(TOOL_SNAPSHOT.body)));
    expect(s.getTemplate(digest)).toEqual(TOOL_SNAPSHOT.body);
    expect(result.spec.inputs).toEqual([
      { slot: "reads", src: "hda", id: "4b6e2f1a9c3d5e70", required: true },
    ]);
  });

  it("refuses what validation refuses, and writes nothing", () => {
    const s = store();
    const result = approve(s, toolProposal({ inputs: [] }));
    expect(result.ok).toBe(false);
    expect(Object.keys(s.snapshot().attempts)).toEqual([]);
  });

  it("refuses a proposal for another server", () => {
    const s = store();
    const result = approve(s, toolProposal({ serverUrl: "https://elsewhere.example" }));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.problems[0]).toMatch(/this session is connected to/);
  });

  it("refuses assertions it has no definition to freeze", () => {
    const s = store();
    const result = approve(s, toolProposal({ assertions: ["a1"] }));
    expect(result).toEqual({ ok: false, problems: ['assertion "a1" has no definition to freeze'] });
  });

  it("freezes a user-defined tool's definition digest", () => {
    const s = store();
    const result = approve(
      s,
      toolProposal({
        target: { kind: "udt", tool_uuid: UDT_UUID, version: "unpinned" },
        inputs: [{ slot: "table", src: "hda", id: "d1" }],
        overrides: [],
      }),
      UDT_SNAPSHOT,
    );
    if (!result.ok) throw new Error(result.problems.join("; "));
    const rep = (UDT_SNAPSHOT.body as { representation: unknown }).representation;
    expect(result.spec.target.definition_digest).toBe(sha256Hex(canonicalJson(rep)));
  });

  it("approving the same Spec twice changes nothing", () => {
    const s = store();
    const first = approve(s, toolProposal());
    const second = approve(s, toolProposal());
    expect(second).toMatchObject({ ok: true, unchanged: true });
    if (first.ok && second.ok) expect(second.attemptId).toBe(first.attemptId);
  });

  it("re-approval after a change starts a fresh attempt and revokes the old one", () => {
    const s = store();
    const first = approve(s, toolProposal());
    now += 1000;
    const second = approve(
      s,
      toolProposal({ overrides: [{ param: "threads", value: 8, rationale: "more cores" }] }),
    );
    if (!first.ok || !second.ok) throw new Error("expected both to approve");
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(second.superseded).toEqual([first.attemptId]);
    const reg = s.snapshot();
    expect(reg.attempts[first.attemptId].approval?.status).toBe("revoked");
    // Inherits nothing: no submission, reservation, evaluation.
    const fresh = reg.attempts[second.attemptId];
    expect(fresh.reservation).toBeUndefined();
    expect(fresh.submission).toBeUndefined();
    expect(fresh.evaluation).toBeUndefined();
  });

  it("refuses to record from a read-only store", () => {
    const writer = store("s-a");
    const reader = store("s-b");
    expect(reader.mode).toBe("read-only");
    expect(() => approve(reader, toolProposal())).toThrow(/read-only/);
    writer.close();
  });
});

describe("edit after approve revokes (v3 §13)", () => {
  function approved() {
    const s = store();
    const r = approve(s, toolProposal());
    if (!r.ok) throw new Error(r.problems.join("; "));
    return { s, attemptId: r.attemptId };
  }

  it("leaves an unchanged proposal alone, including a label edit", () => {
    const { s } = approved();
    expect(findDrift(s.snapshot(), [seen(toolProposal())])).toEqual([]);
    expect(findDrift(s.snapshot(), [seen(toolProposal({ label: "renamed" }))])).toEqual([]);
  });

  it("revokes when an input, a parameter, the history or the step changes", () => {
    const edits: Partial<Proposal>[] = [
      { inputs: [{ slot: "reads", src: "hda", id: "0000000000000bad" }] },
      { overrides: [{ param: "threads", value: 64, rationale: "the queue gives four cores" }] },
      { overrides: [{ param: "threads", value: 4, rationale: "a different reason" }] },
      { historyId: "another-history" },
      { stepAnchor: "plan-a-step-9" },
      { predicate: { kind: "manual" } },
      { target: { kind: "tool", tool_id: "a-different-tool", version: "unpinned" } },
      { target: { kind: "tool", tool_id: TOOL_SNAPSHOT.body.id, version: "9.9" } },
    ];
    for (const edit of edits) {
      const { s, attemptId } = approved();
      expect(findDrift(s.snapshot(), [seen(toolProposal(edit))])).toEqual([
        { attemptId, proposalId: "prop-abc123", reason: "edited" },
      ]);
      fs.rmSync(dir, { recursive: true, force: true });
      dir = tmpAnalysisDir();
    }
  });

  it("pinning the version approval resolved is not an edit", () => {
    const { s } = approved();
    const pinned = toolProposal({
      target: { kind: "tool", tool_id: TOOL_SNAPSHOT.body.id, version: "0.23.4+galaxy0" },
    });
    expect(findDrift(s.snapshot(), [seen(pinned)])).toEqual([]);
  });

  it("revokes when the block is removed, duplicated, or unreadable", () => {
    const { s, attemptId } = approved();
    const base = { attemptId, proposalId: "prop-abc123" };
    expect(findDrift(s.snapshot(), [])).toEqual([{ ...base, reason: "removed" }]);
    expect(findDrift(s.snapshot(), [seen(toolProposal()), seen(toolProposal())])).toEqual([
      { ...base, reason: "duplicated" },
    ]);
    expect(findDrift(s.snapshot(), [seen(null, "prop-abc123")])).toEqual([
      { ...base, reason: "unreadable" },
    ]);
  });

  it("revokeDrifted flips the status in the signed registry", () => {
    const { s, attemptId } = approved();
    const drift = revokeDrifted(s, [seen(toolProposal({ historyId: "other" }))]);
    expect(drift).toHaveLength(1);
    expect(s.snapshot().attempts[attemptId].approval?.status).toBe("revoked");
    const onDisk = JSON.parse(fs.readFileSync(s.registryPath, "utf-8"));
    expect(onDisk.attempts[attemptId].approval.status).toBe("revoked");
  });

  it("/revoke revokes every live approval of the proposal and nothing else", () => {
    const { s, attemptId } = approved();
    const other = approve(s, toolProposal({ proposalId: "prop-zzz999" }));
    expect(revokeProposal(s, "prop-abc123")).toEqual([attemptId]);
    expect(revokeProposal(s, "prop-abc123")).toEqual([]);
    if (other.ok) expect(s.snapshot().attempts[other.attemptId].approval?.status).toBe("live");
  });
});

describe("/pending (v3 §13)", () => {
  it("lists proposals without a live approval, saying why", () => {
    const s = store();
    const a = toolProposal({ proposalId: "prop-aaaaaa" });
    const b = toolProposal({ proposalId: "prop-bbbbbb" });
    const c = toolProposal({ proposalId: "prop-cccccc" });
    approve(s, a);
    approve(s, c);
    revokeProposal(s, "prop-cccccc");
    const pending = pendingProposals(s.snapshot(), [
      seen(a),
      seen(b),
      seen(c),
      seen(null, "prop-dddddd"),
    ]);
    expect(pending.map((p) => [p.sighting.proposalId, p.state])).toEqual([
      ["prop-bbbbbb", "unapproved"],
      ["prop-cccccc", "revoked"],
      ["prop-dddddd", "invalid"],
    ]);
  });
});

describe("import of a foreign registry leaves approvals restored, never live (v3 §13)", () => {
  it("a new session reads the old approval as restored and lists the proposal as pending", () => {
    const first = store("s-a");
    const r = approve(first, toolProposal());
    if (!r.ok) throw new Error("approve failed");
    first.close();
    // A later session has a different in-memory key, so the file is an import.
    const second = store("s-b");
    const a = second.snapshot().attempts[r.attemptId];
    expect(a.approval?.status).toBe("restored");
    expect(findDrift(second.snapshot(), [seen(toolProposal())])).toEqual([]);
    expect(pendingProposals(second.snapshot(), [seen(toolProposal())])).toEqual([
      { sighting: seen(toolProposal()), state: "restored" },
    ]);
    // And it can be approved afresh, on a new attempt.
    const again = approve(second, toolProposal());
    expect(again).toMatchObject({ ok: true, unchanged: false });
  });

  it("a hand-made registry claiming a live approval imports as restored", () => {
    const s0 = store("s-a");
    const r = approve(s0, toolProposal());
    if (!r.ok) throw new Error("approve failed");
    s0.close();
    const file = path.join(dir, ".loom", "state", "registry.json");
    const doc = JSON.parse(fs.readFileSync(file, "utf-8"));
    doc.session_sig = "0".repeat(64);
    fs.writeFileSync(file, JSON.stringify(doc));
    const s1 = store("s-b");
    expect(s1.snapshot().attempts[r.attemptId].approval?.status).toBe("restored");
  });
});

describe("ids and rendering", () => {
  it("mints short ids that don't collide with taken ones", () => {
    let n = 0;
    const random = (k: number) => new Uint8Array(k).fill(n++ < 1 ? 0 : 1);
    const taken = new Set(["prop-000000"]);
    const id = newProposalId(random, taken);
    expect(id).toBe("prop-111111");
    expect(PROPOSAL_ID_RE.test(id)).toBe(true);
  });

  it("renders the table from the proposal, escaping pipes and newlines", () => {
    const table = renderProposalTable(
      toolProposal({
        overrides: [{ param: "threads", value: 4, rationale: "a | b\nc" }],
      }),
      { resolvedVersion: "0.23.4+galaxy0", specRevision: "e".repeat(64) },
    );
    expect(table).toContain("| Proposal | prop-abc123 |");
    expect(table).toContain("@ 0.23.4+galaxy0 (resolved)");
    expect(table).toContain("a \\| b c");
    expect(table).toContain("| spec_revision | eeeeeeeeeeee |");
  });
});
