import { describe, it, expect } from "vitest";
import path from "node:path";
import { parseSessionFile } from "../../extensions/loom/session-index/parse";

const FIXTURE_DIR = path.resolve(__dirname, "fixtures");

describe("parseSessionFile", () => {
  it("extracts header, entries, and role/text from a basic session", () => {
    const r = parseSessionFile(path.join(FIXTURE_DIR, "basic-session.jsonl"));
    expect(r.header.id).toBe("sess-basic");
    expect(r.header.cwd).toBe("/tmp/proj");
    expect(r.entries).toHaveLength(3);

    const [e1, e2, e3] = r.entries;
    expect(e1.entry_id).toBe("e1");
    expect(e1.role).toBe("user");
    expect(e1.text_content).toBe("hello from fixture");

    expect(e2.role).toBe("assistant");
    expect(e2.text_content).toBe("hi! this is the assistant reply");

    expect(e3.entry_type).toBe("custom");
    expect(e3.role).toBeNull();
    // galaxy_analyst_plan notebookPath is surfaced so the indexer can set it on sessions
    expect(r.notebookPath).toBe("/tmp/proj/notebook.md");
    expect(r.tool_calls).toHaveLength(0);
  });

  it("extracts tool calls and joins results by tool_use_id", () => {
    const r = parseSessionFile(path.join(FIXTURE_DIR, "tool-call-session.jsonl"));
    expect(r.tool_calls).toHaveLength(1);
    const tc = r.tool_calls[0];
    expect(tc.entry_id).toBe("t2");
    expect(tc.tool_name).toBe("workflow_set_overrides");
    expect(JSON.parse(tc.arguments_json)).toEqual({
      stepId: "ism",
      overrides: { variant_ism_width: 600 },
    });
    expect(tc.result_text).toBe("overrides recorded");
  });

  it("is byte-offset aware for incremental parsing", () => {
    const r = parseSessionFile(path.join(FIXTURE_DIR, "basic-session.jsonl"));
    expect(r.endOffset).toBeGreaterThan(0);
    // Starting from the final offset yields zero new entries
    const r2 = parseSessionFile(path.join(FIXTURE_DIR, "basic-session.jsonl"), {
      startOffset: r.endOffset,
      skipHeader: true,
    });
    expect(r2.entries).toHaveLength(0);
    expect(r2.endOffset).toBe(r.endOffset);
  });
});
