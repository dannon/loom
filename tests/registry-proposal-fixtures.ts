/**
 * Template bodies and proposals for the propose/approve tests. The tool body
 * is the shape `GET /api/tools/{id}?io_details=true` returns, trimmed to the
 * fields the validator reads; the workflow body is what `/approve` freezes
 * for a workflow (details at the version plus the run form's slots).
 */

import type { Proposal } from "../extensions/loom/registry-proposal";
import type { TemplateSnapshot } from "../extensions/loom/registry-submitter";
import { SERVER } from "./registry-fixtures";

export const TOOL_ID = "toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/0.23.4+galaxy0";

export const TOOL_BODY = {
  id: TOOL_ID,
  name: "fastp",
  version: "0.23.4+galaxy0",
  inputs: [
    {
      name: "single_paired",
      type: "conditional",
      test_param: { name: "single_paired_selector", type: "select" },
      cases: [
        { value: "single", inputs: [{ name: "in1", type: "data", label: "Input 1" }] },
        {
          value: "paired",
          inputs: [
            { name: "in1", type: "data" },
            { name: "in2", type: "data" },
          ],
        },
      ],
    },
    { name: "reads", type: "data", label: "Reads", optional: false },
    { name: "adapters", type: "data", optional: true },
    { name: "pool", type: "data_collection", optional: true },
    {
      name: "filter_options",
      type: "section",
      inputs: [{ name: "length_required", type: "integer" }],
    },
    {
      name: "queries",
      type: "repeat",
      inputs: [
        { name: "extra", type: "data" },
        { name: "tag", type: "text" },
      ],
    },
    { name: "threads", type: "integer" },
  ],
};

export const TOOL_SNAPSHOT: TemplateSnapshot = { body: TOOL_BODY, version: "0.23.4+galaxy0" };

export const WORKFLOW_SNAPSHOT: TemplateSnapshot = {
  version: "3",
  body: {
    workflow: { id: "f2db41e1fa331b3e", name: "QC", version: 3 },
    slots: [
      { step_index: 0, label: "forward", input_type: "data", optional: false },
      { step_index: 1, label: "samples", input_type: "data_collection", optional: false },
      { step_index: 2, label: "min length", input_type: "parameter", optional: true },
      { step_index: 3, label: "notes", input_type: "data", optional: true },
    ],
  },
};

export const UDT_UUID = "8a2f6d1e-4b3c-4f5e-9a7b-1c2d3e4f5a6b";

export const UDT_SNAPSHOT: TemplateSnapshot = {
  version: "0.2.0",
  body: {
    uuid: UDT_UUID,
    active: true,
    representation: {
      class: "GalaxyUserTool",
      id: "count_lines",
      version: "0.2.0",
      inputs: [
        { name: "table", type: "data", format: "tabular" },
        { name: "skip", type: "integer", optional: true },
      ],
    },
  },
};

export function toolProposal(over: Partial<Proposal> = {}): Proposal {
  return {
    proposalId: "prop-abc123",
    stepAnchor: "plan-a-step-1",
    label: "Trim reads",
    target: { kind: "tool", tool_id: TOOL_ID, version: "unpinned" },
    serverUrl: SERVER,
    historyId: "df8fe5ddadbf3ab1",
    inputs: [{ slot: "reads", src: "hda", id: "4b6e2f1a9c3d5e70" }],
    overrides: [{ param: "threads", value: 4, rationale: "the queue gives four cores" }],
    predicate: { kind: "exists_with_ext", ext: "fastqsanger", min_count: 1 },
    assertions: [],
    ...over,
  };
}
