/**
 * `loom-udt` notebook blocks: a pointer to a user-defined tool's definition.
 *
 * A UDT lives in Galaxy's database, scoped to the user who made it. That is
 * fine until the analysis outlives the account, the server, or the tool --
 * at which point the notebook says a tool ran and nothing says what it was.
 * So when the harness sees a UDT created, it writes the definition Galaxy
 * stored to `<analysis>/.loom/provenance/udt/<tool_id>.yaml` and drops this
 * block in the notebook pointing at it.
 *
 * Keyed on `tool_uuid`, which is what `run_user_tool` takes, so a run can be
 * traced back to the exact definition it used. Re-creating the same tool id
 * yields a new uuid and therefore a new block, which is correct: a redefined
 * tool is a different tool.
 *
 * ```loom-udt
 * tool_id: clean_table
 * tool_uuid: 8d5f1c2e-...
 * definition: .loom/provenance/udt/clean_table.yaml
 * created_at: 2026-09-16T15:30:00Z
 * notebook_anchor: plan-a-step-2
 * attempt_id: 01K5CJ6XWQ8QK4S2M7E9V0TZ3B
 * ```
 */

export interface UdtYaml {
  toolId: string;
  toolUuid: string;
  /** Repo-relative path to the stored definition. */
  definition: string;
  createdAt: string;
  notebookAnchor: string;
  attemptId?: string;
}

const UDT_FENCE_OPEN = "```loom-udt";
const UDT_FENCE_CLOSE = "```";

function escapeYaml(value: string): string {
  if (value === "") return '""';
  if (/^[\w .\-/]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function unescapeYaml(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export function renderUdtYaml(udt: UdtYaml): string {
  const lines: string[] = [
    UDT_FENCE_OPEN,
    `tool_id: ${escapeYaml(udt.toolId)}`,
    `tool_uuid: ${escapeYaml(udt.toolUuid)}`,
    `definition: ${escapeYaml(udt.definition)}`,
    `created_at: ${udt.createdAt}`,
    `notebook_anchor: ${udt.notebookAnchor}`,
  ];
  if (udt.attemptId) lines.push(`attempt_id: ${udt.attemptId}`);
  lines.push(UDT_FENCE_CLOSE);
  return lines.join("\n") + "\n";
}

function parseUdtBlock(blockLines: string[]): UdtYaml | null {
  const map = new Map<string, string>();
  for (const line of blockLines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    map.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  const toolUuid = map.get("tool_uuid");
  const toolId = map.get("tool_id");
  const definition = map.get("definition");
  if (!toolUuid || !toolId || !definition) return null;
  return {
    toolId: unescapeYaml(toolId),
    toolUuid: unescapeYaml(toolUuid),
    definition: unescapeYaml(definition),
    createdAt: map.get("created_at") ?? "",
    notebookAnchor: map.get("notebook_anchor") ?? "",
    attemptId: map.get("attempt_id") || undefined,
  };
}

export function findUdtBlocks(content: string): UdtYaml[] {
  const out: UdtYaml[] = [];
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === UDT_FENCE_OPEN) {
      const start = i + 1;
      let end = start;
      while (end < lines.length && lines[end].trim() !== UDT_FENCE_CLOSE) end++;
      const parsed = parseUdtBlock(lines.slice(start, end));
      if (parsed) out.push(parsed);
      i = end + 1;
    } else {
      i++;
    }
  }
  return out;
}

/** Upsert a `loom-udt` block keyed by `tool_uuid`. */
export function upsertUdtBlock(content: string, udt: UdtYaml): string {
  const lines = content.split("\n");
  const newBlock = renderUdtYaml(udt).trimEnd().split("\n");

  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === UDT_FENCE_OPEN) {
      const start = i;
      let end = start + 1;
      while (end < lines.length && lines[end].trim() !== UDT_FENCE_CLOSE) end++;
      const parsed = parseUdtBlock(lines.slice(start + 1, end));
      if (parsed && parsed.toolUuid === udt.toolUuid) {
        return [...lines.slice(0, start), ...newBlock, ...lines.slice(end + 1)].join("\n");
      }
      i = end + 1;
    } else {
      i++;
    }
  }

  const trimmed = content.replace(/\s+$/, "");
  const sep = trimmed.length > 0 ? "\n\n" : "";
  return trimmed + sep + newBlock.join("\n") + "\n";
}
