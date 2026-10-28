import { describe, expect, it } from "vitest";
import { format } from "prettier";

import { applyJobPollUpdate } from "../extensions/loom/galaxy-job-block";
import { applyJobOutcome } from "../browser/core/src/agent/record-jobs";

// Both shells advance the record when a Galaxy job settles, from different data
// models: loom rewrites its loom-job block, the browser stamps the line carrying
// the job id and ticks the step. One record holding both shapes, run through
// each for a completed and a failed job, pins where they disagree (#567 2.2).
const FIXTURE = `## Plan A: chrM Variant Calling [remote]

- [ ] 1. **Align to chrM reference** -- BWA-MEM, sorted BAM out
  - Routing: galaxy
  - Galaxy job \`abc123\` — submitted, awaiting completion

\`\`\`loom-job
job_id: abc123
galaxy_server_url: https://usegalaxy.org
notebook_anchor: plan-a-step-1
label: BWA alignment
tool_id: bwa_mem
submitted_at: 2026-10-11T12:00:00Z
status: in_progress
summary: ""
\`\`\`

*Submitted jobs are currently running.*
`;

const OUTCOMES = {
  completed: { status: "completed", state: "ok" },
  failed: { status: "failed", state: "error" },
} as const;

/**
 * What `after` changes in FIXTURE, as "-N line" for a fixture line it drops and "+N line" for a
 * line it adds at N, both 1-based: the fixture plus these rebuilds the output exactly.
 */
function changes(after: string): string[] {
  const a = FIXTURE.split("\n");
  const b = after.split("\n");
  // Longest common subsequence, filled from the end so the walk below goes forward.
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let [i, j] = [0, 0];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) [i, j] = [i + 1, j + 1];
    else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1]))
      out.push(`-${++i} ${a[i - 1]}`);
    else out.push(`+${++j} ${b[j - 1]}`);
  }
  return out;
}

describe("a settled job, as each shell records it", () => {
  it("pins loom's and the browser's record for a completed and a failed job", async () => {
    const report = Object.fromEntries(
      Object.entries(OUTCOMES).map(([outcome, { status, state }]) => [
        outcome,
        {
          loom: changes(
            applyJobPollUpdate(FIXTURE, {
              jobId: "abc123",
              status,
              galaxyState: state,
              lastPolledAt: "2026-10-11T12:30:00Z",
            }),
          ),
          browser: changes(
            applyJobOutcome(FIXTURE, { id: "abc123", kind: "job", state, outcome: status }),
          ),
        },
      ]),
    );
    const json = await format(JSON.stringify(report, null, 2), {
      parser: "json",
      printWidth: 100,
    });
    await expect(json).toMatchFileSnapshot("__surface__/record-outcome-parity.json");
  });
});
