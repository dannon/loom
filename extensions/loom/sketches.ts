/**
 * Loader for gxy-sketches corpus -- Anton's static analysis-scaffolding
 * sketches authored at github.com/nekrut/gxy-sketches.
 *
 * Loom treats sketches as a knowledge layer: when an active plan's tools,
 * workflow, or tags match a sketch, its body is injected into the system
 * prompt so the agent has domain grounding for that class of analysis.
 *
 * We only parse the subset of the SketchFrontmatter schema we actually
 * need for matching and rendering. Unknown fields are tolerated so schema
 * drift upstream doesn't break sketch loading here.
 */

import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import type { AnalysisPlan } from "./types";

/** Cap on a single sketch's size on disk. Oversized files are skipped. */
const MAX_SKETCH_BYTES = 200 * 1024;

export interface SketchToolRef {
  name: string;
  version?: string;
}

export interface SketchExpectedOutput {
  role?: string;
  description?: string;
  assertions?: string[];
}

export interface SketchFrontmatter {
  name: string;
  description?: string;
  domain?: string;
  tags?: string[];
  tools?: SketchToolRef[];
  source?: {
    ecosystem?: string;
    workflow?: string;
    url?: string;
    version?: string;
  };
  expected_output?: SketchExpectedOutput[];
}

export interface LoadedSketch {
  filePath: string;
  frontmatter: SketchFrontmatter;
  body: string;
}

export interface MatchedSketch extends LoadedSketch {
  score: number;
  reason: string;
}

/**
 * Walk the corpus directory and return every sketch we could load.
 * Malformed files emit a warning and are skipped rather than throwing.
 */
export function loadSketchCorpus(corpusRoot: string): LoadedSketch[] {
  if (!corpusRoot) return [];
  if (!fs.existsSync(corpusRoot) || !fs.statSync(corpusRoot).isDirectory()) {
    return [];
  }

  const sketches: LoadedSketch[] = [];
  const sketchesRoot = path.join(corpusRoot, "sketches");
  const scanRoot = fs.existsSync(sketchesRoot) ? sketchesRoot : corpusRoot;

  for (const filePath of walkForSketchFiles(scanRoot)) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_SKETCH_BYTES) {
        console.warn(`[sketches] skipping ${filePath}: exceeds ${MAX_SKETCH_BYTES} bytes`);
        continue;
      }

      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = parseSketch(raw);
      if (!parsed) {
        console.warn(`[sketches] skipping ${filePath}: missing or malformed frontmatter`);
        continue;
      }

      sketches.push({ filePath, ...parsed });
    } catch (err) {
      console.warn(`[sketches] failed to read ${filePath}:`, err);
    }
  }

  return sketches;
}

/**
 * Parse a sketch markdown file into its frontmatter + body.
 * Returns null if the frontmatter is missing or lacks the required `name`.
 */
export function parseSketch(
  raw: string,
): { frontmatter: SketchFrontmatter; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = parseYamlFrontmatter(match[1]);
  if (!frontmatter || !frontmatter.name) return null;

  return { frontmatter, body: match[2].trim() };
}

/**
 * Rank loaded sketches against a plan. Returns matches sorted strongest-first;
 * the caller can slice to top-N. Empty array if no signal.
 *
 * Priority signal: exact source.workflow id match > tool-id overlap > tag overlap.
 */
export function matchSketchesForPlan(
  plan: AnalysisPlan,
  sketches: LoadedSketch[],
): MatchedSketch[] {
  const planToolIds = new Set<string>();
  const planToolShortNames = new Set<string>();
  for (const step of plan.steps) {
    const id = step.execution.toolId;
    if (!id) continue;
    planToolIds.add(id);
    planToolShortNames.add(shortToolName(id));
  }

  const planWorkflowId = plan.steps
    .map((s) => s.execution.workflowId)
    .find((id): id is string => Boolean(id));

  const planTags = new Set<string>();
  if (plan.brcContext?.analysisCategory) {
    planTags.add(plan.brcContext.analysisCategory.toLowerCase());
  }

  const matched: MatchedSketch[] = [];
  for (const sketch of sketches) {
    const { frontmatter } = sketch;

    let score = 0;
    const reasons: string[] = [];

    if (planWorkflowId && frontmatter.source?.workflow === planWorkflowId) {
      score += 100;
      reasons.push("exact workflow match");
    }

    const toolHits = (frontmatter.tools || []).filter((t) => {
      return planToolIds.has(t.name) || planToolShortNames.has(t.name);
    });
    if (toolHits.length > 0) {
      score += toolHits.length * 10;
      reasons.push(`${toolHits.length} tool match(es)`);
    }

    const tagHits = (frontmatter.tags || []).filter((tag) =>
      planTags.has(tag.toLowerCase()),
    );
    if (tagHits.length > 0) {
      score += tagHits.length;
      reasons.push(`${tagHits.length} tag match(es)`);
    }

    if (score > 0) {
      matched.push({ ...sketch, score, reason: reasons.join("; ") });
    }
  }

  matched.sort((a, b) => b.score - a.score);
  return matched;
}

/**
 * Format a matched sketch as a markdown system-prompt fragment.
 */
export function renderSketchForPrompt(sketch: MatchedSketch): string {
  const lines: string[] = [];
  lines.push(`## Analysis Sketch: ${sketch.frontmatter.name}`);
  lines.push(`*(matched via ${sketch.reason})*`);
  lines.push("");

  if (sketch.frontmatter.description) {
    lines.push(sketch.frontmatter.description);
    lines.push("");
  }

  const assertions = (sketch.frontmatter.expected_output || [])
    .flatMap((eo) => eo.assertions || [])
    .filter(Boolean);
  if (assertions.length > 0) {
    lines.push("**Expected outputs (ground-truth checks):**");
    for (const a of assertions) {
      lines.push(`- ${a}`);
    }
    lines.push("");
  }

  lines.push(sketch.body);
  lines.push("");
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

function* walkForSketchFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walkForSketchFiles(full);
    } else if (ent.isFile() && (ent.name === "SKETCH.md" || ent.name.endsWith(".sketch.md"))) {
      yield full;
    }
  }
}

/**
 * Parse the YAML frontmatter block via the `yaml` library. Any parse or
 * schema failure returns null so malformed sketches skip cleanly.
 */
function parseYamlFrontmatter(src: string): SketchFrontmatter | null {
  try {
    const parsed = parseYaml(src) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const fm = parsed as SketchFrontmatter;
    if (!fm.name || typeof fm.name !== "string") return null;
    return fm;
  } catch {
    return null;
  }
}

/**
 * Short tool name for matcher: "toolshed.../repos/iuc/hisat2/hisat2/2.2.1" -> "hisat2"
 */
function shortToolName(toolId: string): string {
  const parts = toolId.split("/");
  if (parts.length >= 2) return parts[parts.length - 2];
  return toolId;
}
