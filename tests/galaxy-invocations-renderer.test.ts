/**
 * The Orbit Activity panel parses `loom-invocation` blocks itself rather than
 * importing the brain's parser (renderer/main boundary), so the two parsers
 * drift silently unless something pins them together. This covers the half the
 * brain just started writing: `server_verified`.
 */

import { describe, expect, it } from "vitest";
import { renderInvocationYaml, type InvocationYaml } from "../extensions/loom/notebook-writer";
import { parseInvocationBlocks } from "../app/src/renderer/galaxy-invocations.js";

function invocation(overrides: Partial<InvocationYaml> = {}): InvocationYaml {
  return {
    invocationId: "inv-1",
    galaxyServerUrl: "https://usegalaxy.org",
    notebookAnchor: "plan-a-step-1",
    label: "BWA alignment",
    submittedAt: "2026-09-16T15:30:00Z",
    status: "in_progress",
    ...overrides,
  };
}

describe("renderer parseInvocationBlocks", () => {
  it("reads server_verified as the brain writes it", () => {
    for (const verified of [true, false]) {
      const parsed = parseInvocationBlocks(
        renderInvocationYaml(invocation({ serverVerified: verified })),
      );
      expect(parsed[0].serverVerified).toBe(verified);
    }
  });

  it("leaves a block without the field unclaimed rather than unverified", () => {
    const parsed = parseInvocationBlocks(renderInvocationYaml(invocation()));
    expect(parsed[0].serverVerified).toBeUndefined();
  });

  it("still parses every other field the panel draws", () => {
    const parsed = parseInvocationBlocks(
      renderInvocationYaml(
        invocation({
          serverVerified: false,
          totalSteps: 3,
          completedSteps: 1,
          totalJobs: 6,
          completedJobs: 2,
          failedJobs: 0,
        }),
      ),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      invocationId: "inv-1",
      label: "BWA alignment",
      status: "in_progress",
      totalSteps: 3,
      completedJobs: 2,
    });
  });
});
