/**
 * Proposals and approvals (registry design v3 §4-§5): the model proposes a
 * concrete run, the user approves it, the harness freezes it.
 *
 * A proposal is the model's one write. It lives in the notebook as a
 * `loom-proposal` block and is untrusted from end to end: anything in it can
 * have been typed by the model or edited by hand. An approval is the
 * harness's: the template fetched from Galaxy and frozen, the version
 * resolved, the Spec hashed, and an `approval` recorded on a fresh attempt in
 * the signed registry. The block may echo a `spec_revision` afterwards for
 * the reader's benefit, but nothing here ever reads one back; the registry,
 * not the block, says what was approved.
 *
 * Revoke on edit is "the hash no longer matches", literally: the Spec is
 * rebuilt from the block as it reads now, against what was frozen at
 * approval, and hashed. A different `spec_revision` means the proposal no
 * longer says what the user approved.
 *
 * Same coupling rule as the rest of the trusted core: Node builtins and the
 * registry's own modules only. Fetching templates is the caller's job.
 */

import type { RegistryStore } from "./registry";
import {
  canonicalJson,
  normalizeServerUrl,
  parseSpec,
  sha256Hex,
  specRevision,
  type Attempt,
  type AttemptId,
  type Predicate,
  type Registry,
  type Spec,
} from "./registry-schema";
import type { TemplateSnapshot } from "./registry-submitter";

// ─────────────────────────────────────────────────────────────────────────────
// The proposal
// ─────────────────────────────────────────────────────────────────────────────

export type TargetKind = Spec["target"]["kind"];
export type InputSrc = Spec["inputs"][number]["src"];

/** What a proposal names. `version` may be "unpinned"; a Spec's never is. */
export interface ProposalTarget {
  kind: TargetKind;
  workflow_id?: string;
  tool_id?: string;
  tool_uuid?: string;
  version: string;
}

export interface ProposalInput {
  slot: string;
  src: InputSrc;
  id: string;
}

export interface ProposalOverride {
  param: string;
  value: unknown;
  rationale: string;
}

export interface Proposal {
  proposalId: string;
  stepAnchor: string;
  label?: string;
  target: ProposalTarget;
  serverUrl: string;
  historyId: string;
  inputs: ProposalInput[];
  overrides: ProposalOverride[];
  predicate: Predicate;
  /** Ids of assertions whose definitions get frozen into the Spec. */
  assertions: string[];
  /** The template the proposal was validated against when it was written. */
  templateDigest?: string;
  createdAt?: string;
}

export const UNPINNED = "unpinned";

/** `prop-` and six lowercase Crockford characters: short enough to type. */
export const PROPOSAL_ID_RE = /^prop-[0-9a-hjkmnp-tv-z]{6}$/;

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

export function newProposalId(random: (n: number) => Uint8Array, taken: Set<string>): string {
  for (let tries = 0; tries < 100; tries++) {
    const bytes = random(6);
    let id = "prop-";
    for (const b of bytes) id += CROCKFORD[b % 32];
    if (!taken.has(id)) return id;
  }
  throw new Error("could not mint an unused proposal id");
}

/** The id field a target of this kind is named by. */
export function targetIdField(kind: TargetKind): "workflow_id" | "tool_id" | "tool_uuid" {
  return kind === "workflow" ? "workflow_id" : kind === "tool" ? "tool_id" : "tool_uuid";
}

export function targetId(t: { kind: TargetKind } & Partial<ProposalTarget>): string | undefined {
  return t[targetIdField(t.kind)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing the block's fields
// ─────────────────────────────────────────────────────────────────────────────

const MAX_FIELD = 4096;
const ID_TOKEN = /^[A-Za-z0-9._:/+@~-]{1,512}$/;

/**
 * Turn a block's raw `key: value` fields into a Proposal, or say what is
 * wrong with it. Collection fields are single-line JSON, like the harness
 * fields on the other block types. Unknown keys are ignored, so a block
 * written by a newer Loom still reads. `spec_revision` is never read: it is
 * display only, and the registry is the truth.
 */
export function parseProposalFields(get: (key: string) => string | undefined): {
  proposal: Proposal | null;
  errors: string[];
} {
  const errors: string[] = [];
  const text = (key: string, required = true): string | undefined => {
    const v = get(key);
    if (v === undefined || v === "") {
      if (required) errors.push(`${key} is missing`);
      return undefined;
    }
    if (v.length > MAX_FIELD) {
      errors.push(`${key} is too long`);
      return undefined;
    }
    return v;
  };
  const json = (key: string): unknown => {
    const raw = text(key);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      errors.push(`${key} is not valid JSON`);
      return undefined;
    }
  };

  const proposalId = text("proposal_id");
  if (proposalId !== undefined && !ID_TOKEN.test(proposalId)) {
    errors.push("proposal_id has characters a proposal id cannot");
  }
  const stepAnchor = text("step_anchor");
  const serverUrl = text("server_url");
  const historyId = text("history_id");
  if (historyId !== undefined && !ID_TOKEN.test(historyId)) {
    errors.push("history_id is not an id");
  }
  const target = parseTarget(json("target"), errors);
  const inputs = parseInputs(json("inputs"), errors);
  const overrides = parseOverrides(json("overrides"), errors);
  const predicate = parsePredicate(json("predicate"), errors);
  const assertionsRaw = get("assertions") === undefined ? [] : json("assertions");
  const assertions = parseStringList(assertionsRaw, "assertions", errors);
  const templateDigest = text("template_digest", false);
  if (templateDigest !== undefined && !/^[0-9a-f]{64}$/.test(templateDigest)) {
    errors.push("template_digest is not a sha256 digest");
  }

  if (
    errors.length > 0 ||
    !proposalId ||
    !stepAnchor ||
    !serverUrl ||
    !historyId ||
    !target ||
    !inputs ||
    !overrides ||
    !predicate ||
    !assertions
  ) {
    return { proposal: null, errors };
  }
  const proposal: Proposal = {
    proposalId,
    stepAnchor,
    target,
    serverUrl,
    historyId,
    inputs,
    overrides,
    predicate,
    assertions,
  };
  const label = text("label", false);
  if (label !== undefined) proposal.label = label;
  if (templateDigest !== undefined) proposal.templateDigest = templateDigest;
  const createdAt = text("created_at", false);
  if (createdAt !== undefined) proposal.createdAt = createdAt;
  return { proposal, errors };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function parseTarget(v: unknown, errors: string[]): ProposalTarget | null {
  if (v === undefined) return null;
  if (!isRecord(v)) {
    errors.push("target must be an object");
    return null;
  }
  const kind = v.kind;
  if (kind !== "workflow" && kind !== "tool" && kind !== "udt") {
    errors.push("target.kind must be workflow, tool or udt");
    return null;
  }
  const field = targetIdField(kind);
  const id = v[field];
  if (typeof id !== "string" || !ID_TOKEN.test(id)) {
    errors.push(`target.${field} is required for a ${kind}`);
    return null;
  }
  for (const other of ["workflow_id", "tool_id", "tool_uuid"] as const) {
    if (other !== field && v[other] !== undefined) {
      errors.push(`target.${other} does not belong on a ${kind}`);
      return null;
    }
  }
  const version = v.version === undefined ? UNPINNED : v.version;
  if (typeof version !== "string" || version === "" || version.length > 256) {
    errors.push(`target.version must be a version or "${UNPINNED}"`);
    return null;
  }
  return { kind, [field]: id, version } as ProposalTarget;
}

export function parseInputs(v: unknown, errors: string[]): ProposalInput[] | null {
  if (v === undefined) return null;
  if (!Array.isArray(v)) {
    errors.push("inputs must be a list");
    return null;
  }
  const out: ProposalInput[] = [];
  for (const [i, x] of v.entries()) {
    if (
      !isRecord(x) ||
      typeof x.slot !== "string" ||
      x.slot === "" ||
      x.slot.length > 512 ||
      (x.src !== "hda" && x.src !== "hdca" && x.src !== "ldda") ||
      typeof x.id !== "string" ||
      !ID_TOKEN.test(x.id)
    ) {
      errors.push(`inputs[${i}] needs a slot, a src of hda/hdca/ldda, and a dataset id`);
      return null;
    }
    out.push({ slot: x.slot, src: x.src, id: x.id });
  }
  return out;
}

export function parseOverrides(v: unknown, errors: string[]): ProposalOverride[] | null {
  if (v === undefined) return null;
  if (!Array.isArray(v)) {
    errors.push("overrides must be a list");
    return null;
  }
  const out: ProposalOverride[] = [];
  for (const [i, x] of v.entries()) {
    if (!isRecord(x) || typeof x.param !== "string" || x.param === "" || x.param.length > 512) {
      errors.push(`overrides[${i}] needs a param name`);
      return null;
    }
    if (typeof x.rationale !== "string" || x.rationale.trim() === "") {
      errors.push(`overrides[${i}] (${x.param}) needs a rationale`);
      return null;
    }
    if (!("value" in x)) {
      errors.push(`overrides[${i}] (${x.param}) needs a value`);
      return null;
    }
    try {
      canonicalJson(x.value);
    } catch {
      errors.push(`overrides[${i}] (${x.param}) has a value JSON cannot hold`);
      return null;
    }
    out.push({ param: x.param, value: x.value, rationale: x.rationale });
  }
  return out;
}

export function parsePredicate(v: unknown, errors: string[]): Predicate | null {
  if (v === undefined) return null;
  if (!isRecord(v)) {
    errors.push("predicate must be an object");
    return null;
  }
  const nonNegInt = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  switch (v.kind) {
    case "manual":
      return { kind: "manual" };
    case "exists_with_ext":
      if (typeof v.ext !== "string" || v.ext === "") break;
      if (v.min_count !== undefined && !nonNegInt(v.min_count)) break;
      return v.min_count === undefined
        ? { kind: "exists_with_ext", ext: v.ext }
        : { kind: "exists_with_ext", ext: v.ext, min_count: v.min_count as number };
    case "count_eq":
      if (!nonNegInt(v.count)) break;
      if (v.ext !== undefined && (typeof v.ext !== "string" || v.ext === "")) break;
      return v.ext === undefined
        ? { kind: "count_eq", count: v.count as number }
        : { kind: "count_eq", count: v.count as number, ext: v.ext as string };
    case "assertions_pass": {
      const ids = parseStringList(v.ids, "predicate.ids", errors);
      if (!ids) return null;
      if (ids.length === 0) {
        errors.push("an assertions_pass predicate needs at least one assertion id");
        return null;
      }
      return { kind: "assertions_pass", ids };
    }
  }
  errors.push(
    "predicate must be {kind: manual}, {kind: exists_with_ext, ext, min_count?}, " +
      "{kind: count_eq, count, ext?} or {kind: assertions_pass, ids}",
  );
  return null;
}

function parseStringList(v: unknown, what: string, errors: string[]): string[] | null {
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x === "" || x.length > 256)) {
    errors.push(`${what} must be a list of ids`);
    return null;
  }
  return v as string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────

/** One dataset input a template accepts. */
export interface TemplateSlot {
  name: string;
  /** Shown beside the canonical name, when the template has a friendlier one. */
  label?: string;
  collection: boolean;
  required: boolean;
  multiple: boolean;
}

/** What a frozen template body says a proposal may name. */
export interface TemplateShape {
  version: string;
  slots: Map<string, TemplateSlot>;
  /** Non-dataset parameter names, in Galaxy's flat `a|b` form; repeats as `name_#`. */
  params: Set<string>;
  /** Repeat names, so `name_3|x` can be read as `name_#|x`. */
  repeats: Set<string>;
  /** Labels that name exactly one slot or parameter, for canonicalizing. */
  aliases: Map<string, string>;
}

function emptyShape(version: string): TemplateShape {
  return {
    version,
    slots: new Map(),
    params: new Set(),
    repeats: new Set(),
    aliases: new Map(),
  };
}

/**
 * Read a tool's `io_details` input list (or a user-defined tool's inputs,
 * which use the same `type` vocabulary) into slots and parameter names.
 *
 * A dataset input is required when it isn't optional and sits outside any
 * conditional or repeat. Inside one, whether it is needed depends on choices
 * the proposal makes, and refusing on a guess would be worse than letting
 * Galaxy say so at submission.
 */
/**
 * A group's members. Galaxy's `io_details` calls them `inputs` (and a
 * conditional's branches `cases`, its selector `test_param`); a user-defined
 * tool's YAML definition calls them `parameters` (`whens`, `test_parameter`).
 */
function children(group: Record<string, unknown>): unknown {
  return group.inputs ?? group.parameters;
}

function walkToolInputs(
  inputs: unknown,
  shape: TemplateShape,
  prefix: string,
  conditional: boolean,
): void {
  if (!Array.isArray(inputs)) return;
  for (const raw of inputs) {
    if (!isRecord(raw) || typeof raw.name !== "string" || raw.name === "") continue;
    const name = `${prefix}${raw.name}`;
    const type = raw.type;
    if (type === "data" || type === "data_collection") {
      shape.slots.set(name, {
        name,
        ...(typeof raw.label === "string" && raw.label !== "" ? { label: raw.label } : {}),
        collection: type === "data_collection",
        required: !conditional && raw.optional !== true,
        multiple: raw.multiple === true,
      });
    } else if (type === "conditional") {
      const testRaw = raw.test_param ?? raw.test_parameter;
      const test = isRecord(testRaw) ? testRaw : null;
      if (test && typeof test.name === "string") shape.params.add(`${name}|${test.name}`);
      const casesRaw = raw.cases ?? raw.whens;
      const cases = Array.isArray(casesRaw) ? casesRaw : [];
      for (const c of cases) {
        if (isRecord(c)) walkToolInputs(children(c), shape, `${name}|`, true);
      }
    } else if (type === "repeat") {
      shape.repeats.add(name);
      walkToolInputs(children(raw), shape, `${name}_#|`, true);
    } else if (type === "section") {
      walkToolInputs(children(raw), shape, `${name}|`, conditional);
    } else if (type === "upload_dataset") {
      continue;
    } else {
      shape.params.add(name);
    }
  }
}

function workflowShape(body: Record<string, unknown>, version: string): TemplateShape {
  const shape = emptyShape(version);
  const labels = new Map<string, string[]>();
  const slots = Array.isArray(body.slots) ? body.slots : [];
  for (const s of slots) {
    if (!isRecord(s) || typeof s.step_index !== "number") continue;
    const name = String(s.step_index);
    const label = typeof s.label === "string" && s.label !== "" ? s.label : undefined;
    if (label) labels.set(label, [...(labels.get(label) ?? []), name]);
    if (s.input_type === "data" || s.input_type === "data_collection") {
      shape.slots.set(name, {
        name,
        ...(label ? { label } : {}),
        collection: s.input_type === "data_collection",
        required: s.optional !== true,
        multiple: false,
      });
    } else if (s.input_type === "parameter") {
      shape.params.add(name);
    }
  }
  for (const [label, names] of labels) if (names.length === 1) shape.aliases.set(label, names[0]);
  return shape;
}

/** A user-defined tool's definition: the record's `representation`, if it has one. */
export function udtDefinition(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  return isRecord(body.representation) ? body.representation : body;
}

/**
 * Read a frozen template body. The bodies are what `/approve` freezes:
 * the tool's `io_details` description, `{workflow, slots}` for a workflow
 * (Galaxy's details at the version plus the run form's slots), or the
 * user-defined tool record from Galaxy.
 */
export function templateShape(kind: TargetKind, snapshot: TemplateSnapshot): TemplateShape {
  const body = snapshot.body;
  if (kind === "workflow") {
    return workflowShape(isRecord(body) ? body : {}, snapshot.version);
  }
  const shape = emptyShape(snapshot.version);
  const source = kind === "udt" ? udtDefinition(body) : isRecord(body) ? body : null;
  walkToolInputs(source?.inputs, shape, "", false);
  for (const slot of shape.slots.values()) {
    if (slot.label && !shape.aliases.has(slot.label)) shape.aliases.set(slot.label, slot.name);
  }
  return shape;
}

/** A parameter name in the template's own spelling, with repeat indices folded. */
function foldRepeats(param: string, repeats: Set<string>): string {
  const parts = param.split("|");
  let prefix = "";
  return parts
    .map((part) => {
      const m = part.match(/^(.+)_(\d+)$/);
      const folded = m && repeats.has(`${prefix}${m[1]}`) ? `${m[1]}_#` : part;
      prefix += `${folded}|`;
      return folded;
    })
    .join("|");
}

/** The template slot a proposal's slot name means, with repeat indices folded. */
export function slotFor(shape: TemplateShape, name: string): TemplateSlot | undefined {
  if (name.includes("_#")) return undefined;
  return shape.slots.get(name) ?? shape.slots.get(foldRepeats(name, shape.repeats));
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical slot and parameter names: a workflow slot named by its label
 * becomes its step index. Returns a copy; the input is untouched. Anything
 * that doesn't resolve is left as written for `validateProposal` to report.
 */
export function canonicalizeProposal(proposal: Proposal, shape: TemplateShape): Proposal {
  const canon = (name: string) =>
    shape.slots.has(name) || shape.params.has(name) ? name : (shape.aliases.get(name) ?? name);
  return {
    ...proposal,
    inputs: proposal.inputs.map((i) => ({ ...i, slot: canon(i.slot) })),
    overrides: proposal.overrides.map((o) => ({ ...o, param: canon(o.param) })),
  };
}

function describeSlots(shape: TemplateShape): string {
  const names = [...shape.slots.values()].map(
    (s) => `${s.name}${s.label && s.label !== s.name ? ` (${s.label})` : ""}`,
  );
  return names.length > 0 ? names.join(", ") : "none";
}

/**
 * Every way the proposal disagrees with the template, or an empty list.
 * Checked: each input names a dataset slot the template has, with a src that
 * slot takes, at most once unless it takes several; every required slot is
 * filled; each override names a parameter the template has and isn't a
 * dataset slot or a duplicate; a pinned version is the version fetched.
 */
export function validateProposal(proposal: Proposal, shape: TemplateShape): string[] {
  const problems: string[] = [];
  const pinned = proposal.target.version !== UNPINNED;
  if (pinned && proposal.target.version !== shape.version) {
    problems.push(
      `version ${proposal.target.version} was asked for but Galaxy has ${shape.version || "no version"}`,
    );
  }

  // Counted by the name as given (two repeat instances are two slots) and,
  // separately, by the template slot they fill, for the required check.
  const filled = new Map<string, number>();
  const covered = new Set<string>();
  for (const input of proposal.inputs) {
    const slot = slotFor(shape, input.slot);
    if (!slot) {
      problems.push(
        `input slot "${input.slot}" is not a dataset input; slots: ${describeSlots(shape)}`,
      );
      continue;
    }
    if (slot.collection && input.src !== "hdca") {
      problems.push(`input slot "${input.slot}" takes a collection (src hdca), not ${input.src}`);
    } else if (!slot.collection && input.src === "hdca") {
      problems.push(
        `input slot "${input.slot}" takes a dataset (src hda or ldda), not a collection`,
      );
    }
    filled.set(input.slot, (filled.get(input.slot) ?? 0) + 1);
    covered.add(slot.name);
  }
  for (const [name, n] of filled) {
    if (n > 1 && !slotFor(shape, name)?.multiple) {
      problems.push(`input slot "${name}" takes one dataset but is given ${n}`);
    }
  }
  for (const slot of shape.slots.values()) {
    if (slot.required && !covered.has(slot.name)) {
      problems.push(
        `required input "${slot.name}"${slot.label && slot.label !== slot.name ? ` (${slot.label})` : ""} is not given`,
      );
    }
  }

  const seen = new Set<string>();
  for (const o of proposal.overrides) {
    if (seen.has(o.param)) problems.push(`parameter "${o.param}" is overridden twice`);
    seen.add(o.param);
    if (slotFor(shape, o.param)) {
      problems.push(`"${o.param}" is a dataset input; give it in inputs, not overrides`);
      continue;
    }
    if (o.param.includes("_#") || !shape.params.has(foldRepeats(o.param, shape.repeats))) {
      problems.push(`"${o.param}" is not a parameter of this ${proposalNoun(proposal)}`);
    }
  }
  return problems;
}

function proposalNoun(p: Proposal): string {
  return p.target.kind === "udt" ? "user-defined tool" : p.target.kind;
}

// ─────────────────────────────────────────────────────────────────────────────
// Building and checking the Spec
// ─────────────────────────────────────────────────────────────────────────────

/** What approval fixed beyond the proposal itself. */
export interface FrozenParts {
  version: string;
  templateRef: Spec["template_ref"];
  definitionDigest?: string;
  required: (slot: string) => boolean;
  assertions: Spec["assertions"];
}

/** The Spec a proposal amounts to, given what approval froze. */
export function buildSpec(proposal: Proposal, frozen: FrozenParts): Spec {
  const field = targetIdField(proposal.target.kind);
  const target: Spec["target"] = {
    kind: proposal.target.kind,
    [field]: targetId(proposal.target),
    version: frozen.version,
  };
  if (frozen.definitionDigest !== undefined) target.definition_digest = frozen.definitionDigest;
  return {
    target,
    server_url: normalizeServerUrl(proposal.serverUrl),
    history_id: proposal.historyId,
    inputs: proposal.inputs.map((i) => ({ ...i, required: frozen.required(i.slot) })),
    overrides: proposal.overrides.map((o) => ({ ...o })),
    template_ref: { ...frozen.templateRef },
    predicate: structuredClone(proposal.predicate),
    assertions: frozen.assertions.map((a) => structuredClone(a)),
  };
}

/**
 * Whether a proposal, read as it is now, still amounts to the approved Spec
 * and is still bound to the same step. A pinned version must be the frozen
 * one; "unpinned" means "whatever approval resolved", so it matches. A label
 * isn't part of what runs, so changing it changes nothing.
 */
export function proposalStillMatches(proposal: Proposal, approved: Attempt): boolean {
  const approval = approved.approval;
  if (!approval) return false;
  if (proposal.stepAnchor !== approved.binding.step_anchor) return false;
  const spec = approval.spec_snapshot;
  if (proposal.target.version !== UNPINNED && proposal.target.version !== spec.target.version) {
    return false;
  }
  const required = new Map(spec.inputs.map((i) => [i.slot, i.required]));
  const frozenAssertions = new Map(spec.assertions.map((a) => [a.id, a]));
  const assertions = proposal.assertions.map(
    (id) => frozenAssertions.get(id) ?? { id, definition_digest: "", definition: null },
  );
  let rebuilt: Spec;
  try {
    rebuilt = buildSpec(proposal, {
      version: spec.target.version,
      templateRef: spec.template_ref,
      definitionDigest: spec.target.definition_digest,
      required: (slot) => required.get(slot) ?? false,
      assertions,
    });
    return specRevision(rebuilt) === approval.spec_revision;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry operations
// ─────────────────────────────────────────────────────────────────────────────

/** Attempts carrying an approval for this proposal, oldest first. */
export function attemptsForProposal(registry: Registry, proposalId: string): Attempt[] {
  return Object.values(registry.attempts)
    .filter((a) => a.approval?.proposal_id === proposalId)
    .sort((a, b) => (a.attempt_id < b.attempt_id ? -1 : 1));
}

export function liveApproval(registry: Registry, proposalId: string): Attempt | undefined {
  return attemptsForProposal(registry, proposalId).find((a) => a.approval?.status === "live");
}

export type ApproveResult =
  | {
      ok: true;
      attemptId: AttemptId;
      specRevision: string;
      spec: Spec;
      /** The same Spec was already approved and live; nothing was written. */
      unchanged: boolean;
      /** Live approvals this one replaced. */
      superseded: AttemptId[];
    }
  | { ok: false; problems: string[] };

export interface ApproveRequest {
  proposal: Proposal;
  /** Fetched from Galaxy just now, for this target. */
  snapshot: TemplateSnapshot;
  /** Current definitions of the assertions the proposal names, by id. */
  assertionDefinitions: Map<string, unknown>;
  /** ISO timestamp. */
  now: string;
}

/**
 * Freeze and record an approval. The caller is responsible for having got
 * here from the user and nowhere else -- this function is the recording, not
 * the consent. Validates again against the freshly fetched template, so a
 * hand-written block or one validated against an older template is held to
 * what Galaxy says now.
 */
export function approveProposal(store: RegistryStore, req: ApproveRequest): ApproveResult {
  const { snapshot, now } = req;
  const shape = templateShape(req.proposal.target.kind, snapshot);
  const proposal = req.proposal;
  const problems = validateProposal(proposal, shape);
  if (normalizeServerUrl(proposal.serverUrl) !== store.serverUrl) {
    problems.push(
      `the proposal is for ${proposal.serverUrl}, but this session is connected to ${store.serverUrl || "no Galaxy server"}`,
    );
  }
  if (!snapshot.version || snapshot.version === UNPINNED) {
    problems.push("Galaxy did not say which version it resolved");
  }
  const assertions: Spec["assertions"] = [];
  for (const id of proposal.assertions) {
    if (!req.assertionDefinitions.has(id)) {
      problems.push(`assertion "${id}" has no definition to freeze`);
      continue;
    }
    const definition = req.assertionDefinitions.get(id);
    assertions.push({ id, definition_digest: sha256Hex(canonicalJson(definition)), definition });
  }
  if (problems.length > 0) return { ok: false, problems };

  const definition = proposal.target.kind === "udt" ? udtDefinition(snapshot.body) : null;
  const digest = store.putTemplate(snapshot.body);
  let spec: Spec;
  try {
    spec = parseSpec(
      buildSpec(proposal, {
        version: snapshot.version,
        templateRef: { digest, fetched_at: now, version: snapshot.version },
        definitionDigest: definition ? sha256Hex(canonicalJson(definition)) : undefined,
        required: (slot) => slotFor(shape, slot)?.required ?? false,
        assertions,
      }),
    );
  } catch (err) {
    return { ok: false, problems: [(err as Error).message] };
  }
  const revision = specRevision(spec);

  const current = store.snapshot();
  const live = attemptsForProposal(current, proposal.proposalId).filter(
    (a) => a.approval?.status === "live",
  );
  // The same proposal against the same template is the same approval, even
  // though a fresh `fetched_at` makes a fresh Spec hash: compare against each
  // live approval with its own frozen template reference put back.
  const same = live.find((a) => {
    const old = a.approval?.spec_snapshot;
    if (!old || a.binding.step_anchor !== proposal.stepAnchor) return false;
    if (old.template_ref.digest !== spec.template_ref.digest) return false;
    return specRevision({ ...spec, template_ref: old.template_ref }) === a.approval?.spec_revision;
  });
  if (same) {
    return {
      ok: true,
      attemptId: same.attempt_id,
      specRevision: same.approval?.spec_revision ?? revision,
      spec: same.approval?.spec_snapshot ?? spec,
      unchanged: true,
      superseded: [],
    };
  }

  const attemptId = store.newAttemptId();
  store.update((draft) => {
    // A re-approval starts over (v3 §5): the old live approval is revoked and
    // the new attempt inherits nothing from it.
    for (const old of live) {
      const a = draft.attempts[old.attempt_id];
      if (a?.approval) a.approval.status = "revoked";
    }
    draft.attempts[attemptId] = {
      attempt_id: attemptId,
      kind: proposal.target.kind,
      binding: { step_anchor: proposal.stepAnchor, bound_at: now },
      server_url: store.serverUrl,
      history_id: proposal.historyId,
      approval: {
        proposal_id: proposal.proposalId,
        spec_revision: revision,
        spec_snapshot: spec,
        status: "live",
        by: "user",
        at: now,
      },
      handoff_eligible: false,
    };
  });
  return {
    ok: true,
    attemptId,
    specRevision: revision,
    spec,
    unchanged: false,
    superseded: live.map((a) => a.attempt_id),
  };
}

/** Revoke every live approval of a proposal. Returns the attempts revoked. */
export function revokeProposal(store: RegistryStore, proposalId: string): AttemptId[] {
  // A restored approval can't submit anything, but a reconcile check made
  // against it can still make its run eligible, so the user can withdraw it.
  const ids = Object.values(store.snapshot().attempts)
    .filter(
      (a) =>
        a.approval?.proposal_id === proposalId &&
        (a.approval.status === "live" || a.approval.status === "restored"),
    )
    .map((a) => a.attempt_id);
  if (ids.length === 0) return [];
  store.update((draft) => {
    for (const id of ids) {
      const approval = draft.attempts[id]?.approval;
      if (approval && approval.status !== "revoked") approval.status = "revoked";
    }
  });
  return ids;
}

function liveOf(registry: Registry, pick: (a: Attempt) => boolean): AttemptId[] {
  return Object.values(registry.attempts)
    .filter((a) => a.approval?.status === "live" && pick(a))
    .map((a) => a.attempt_id);
}

/** Revoke these attempts' live approvals. Returns the ids it was asked to revoke. */
export function revokeAttempts(store: RegistryStore, ids: AttemptId[]): AttemptId[] {
  if (ids.length === 0) return [];
  store.update((draft) => {
    for (const id of ids) {
      const a = draft.attempts[id];
      if (a?.approval?.status === "live") a.approval.status = "revoked";
    }
  });
  return ids;
}

export type DriftReason = "edited" | "removed" | "duplicated" | "unreadable" | "step_removed";

export interface Drift {
  attemptId: AttemptId;
  proposalId: string;
  reason: DriftReason;
}

/** What the notebook says about one proposal id. */
export interface ProposalSighting {
  proposalId: string;
  proposal: Proposal | null;
}

/**
 * Live approvals the notebook no longer backs: the proposal was edited so it
 * no longer amounts to the approved Spec, removed, duplicated (two blocks
 * claiming one id -- there is no telling which was approved), or made
 * unreadable. Pure; `revokeDrifted` applies it.
 */
export function findDrift(
  registry: Registry,
  sightings: ProposalSighting[],
  /** Whether the approved step still exists in the notebook; omitted, it isn't checked. */
  stepExists?: (anchor: string) => boolean,
): Drift[] {
  const byId = new Map<string, ProposalSighting[]>();
  for (const s of sightings) byId.set(s.proposalId, [...(byId.get(s.proposalId) ?? []), s]);
  const drift: Drift[] = [];
  for (const a of Object.values(registry.attempts)) {
    const approval = a.approval;
    if (!approval || approval.status !== "live") continue;
    const seen = byId.get(approval.proposal_id) ?? [];
    const base = { attemptId: a.attempt_id, proposalId: approval.proposal_id };
    if (seen.length === 0) drift.push({ ...base, reason: "removed" });
    else if (seen.length > 1) drift.push({ ...base, reason: "duplicated" });
    else if (!seen[0].proposal) drift.push({ ...base, reason: "unreadable" });
    else if (!proposalStillMatches(seen[0].proposal, a)) drift.push({ ...base, reason: "edited" });
    else if (stepExists && !stepExists(a.binding.step_anchor)) {
      drift.push({ ...base, reason: "step_removed" });
    }
  }
  return drift;
}

export function revokeDrifted(
  store: RegistryStore,
  sightings: ProposalSighting[],
  stepExists?: (anchor: string) => boolean,
): Drift[] {
  const drift = findDrift(store.snapshot(), sightings, stepExists);
  revokeAttempts(
    store,
    drift.map((d) => d.attemptId),
  );
  return drift;
}

export type PendingState = "unapproved" | "revoked" | "restored" | "invalid";

/**
 * Proposals in the notebook without a live approval, in notebook order. A
 * proposal whose last approval was revoked or came back restored from an
 * import is pending again: neither counts.
 */
export function pendingProposals(
  registry: Registry,
  sightings: ProposalSighting[],
): Array<{ sighting: ProposalSighting; state: PendingState }> {
  const out: Array<{ sighting: ProposalSighting; state: PendingState }> = [];
  for (const s of sightings) {
    if (!s.proposal) {
      out.push({ sighting: s, state: "invalid" });
      continue;
    }
    const attempts = attemptsForProposal(registry, s.proposalId);
    if (attempts.some((a) => a.approval?.status === "live")) continue;
    const last = attempts[attempts.length - 1]?.approval?.status;
    out.push({
      sighting: s,
      state: last === "revoked" ? "revoked" : last === "restored" ? "restored" : "unapproved",
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function cell(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

/** A value as JSON, so `4` and `"4"` don't look alike; shortened only when asked. */
function showValue(v: unknown, compact: boolean): string {
  const s = canonicalJson(v);
  return compact && s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

export function describePredicate(p: Predicate): string {
  switch (p.kind) {
    case "manual":
      return "manual (you check the result)";
    case "exists_with_ext":
      return `at least ${p.min_count ?? 1} ${p.ext} output(s)`;
    case "count_eq":
      return `exactly ${p.count}${p.ext ? ` ${p.ext}` : ""} output(s)`;
    case "assertions_pass":
      return `assertions pass: ${p.ids.join(", ")}`;
  }
}

/**
 * The short markdown table the model repeats in chat and `/pending` and
 * `/approve` show. Rendered from the proposal by the harness, so what the
 * user reads is what the block says, not the model's paraphrase of it.
 */
export function renderProposalTable(
  proposal: Proposal,
  /**
   * `compact` shortens long values, for listings. Anything shown to someone
   * about to approve must leave it off: the table is what they consent to.
   */
  opts: {
    resolvedVersion?: string;
    specRevision?: string;
    compact?: boolean;
    plain?: boolean;
  } = {},
): string {
  const t = proposal.target;
  const version =
    opts.resolvedVersion && t.version === UNPINNED
      ? `${opts.resolvedVersion} (resolved)`
      : t.version;
  const rows: Array<[string, string]> = [
    ["Proposal", proposal.proposalId],
    ["Step", proposal.stepAnchor],
    [proposalNoun(proposal), `${targetId(t) ?? "?"} @ ${version}`],
    ["History", proposal.historyId],
  ];
  if (proposal.label) rows.splice(1, 0, ["Label", proposal.label]);
  for (const i of proposal.inputs) rows.push([`input ${i.slot}`, `${i.src} ${i.id}`]);
  for (const o of proposal.overrides) {
    rows.push([
      `param ${o.param}`,
      `${showValue(o.value, opts.compact === true)} -- ${o.rationale}`,
    ]);
  }
  rows.push(["Done when", describePredicate(proposal.predicate)]);
  if (opts.specRevision) rows.push(["spec_revision", opts.specRevision.slice(0, 12)]);
  if (opts.plain) {
    // For notices and dialogs, which show text as-is: aligned columns read
    // better there than markdown pipes.
    const width = Math.max(...rows.map(([k]) => k.length));
    return rows.map(([k, v]) => `${k.padEnd(width)}  ${v.replace(/[\r\n]+/g, " ")}`).join("\n");
  }
  return ["| | |", "|---|---|", ...rows.map(([k, v]) => `| ${cell(k)} | ${cell(v)} |`)].join("\n");
}
