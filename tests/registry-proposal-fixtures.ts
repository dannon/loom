/**
 * Template bodies and proposals for the propose/approve tests. The tool body
 * is the shape `GET /api/tools/{id}?io_details=true` returns, trimmed to the
 * fields the validator reads; the workflow body is what `/approve` freezes
 * for a workflow (details at the version plus the run form's slots).
 */

import type { DatatypesMapping } from "@galaxyproject/galaxy-ops";
import type { Proposal } from "../extensions/orbit/registry-proposal";
import type { TemplateSnapshot } from "../extensions/orbit/registry-submitter";
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
    { name: "bundle", type: "data", multiple: true, optional: true },
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

export const NANOPLOT_ID = "toolshed.g2.bx.psu.edu/repos/iuc/nanoplot/nanoplot/1.46.1+galaxy0";

/**
 * NanoPlot's reads input as usegalaxy.org describes it, trimmed to three of
 * its seven read types: the same `mode|reads|files` slot in every branch,
 * taking one dataset under `batch` and several under `combined`, with the
 * formats depending on `reads|type`.
 */
function nanoplotReads(multiple: boolean) {
  const files = (extensions: string[]) => [{ name: "files", type: "data", multiple, extensions }];
  return {
    name: "reads",
    type: "conditional",
    test_param: { name: "type", type: "select", value: "fastq" },
    cases: [
      { value: "fastq", inputs: files(["fastq", "fastq.gz", "fastq.bz2", "vcf_bgzip"]) },
      { value: "summary", inputs: files(["txt", "zip"]) },
      { value: "bam", inputs: files(["bam"]) },
    ],
  };
}

export const NANOPLOT_SNAPSHOT: TemplateSnapshot = {
  version: "1.46.1+galaxy0",
  body: {
    id: NANOPLOT_ID,
    name: "NanoPlot",
    version: "1.46.1+galaxy0",
    inputs: [
      {
        name: "mode",
        type: "conditional",
        test_param: { name: "choice", type: "select", value: "batch" },
        cases: [
          { value: "batch", inputs: [nanoplotReads(false)] },
          { value: "combined", inputs: [nanoplotReads(true)] },
        ],
      },
      { name: "format", type: "select" },
    ],
  },
};

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

/** Scott's proposal (#615): NanoPlot over a 62-element list of runs. */
export function nanoplotProposal(over: Partial<Proposal> = {}): Proposal {
  return toolProposal({
    label: "Per-sample NanoPlot QC",
    target: { kind: "tool", tool_id: NANOPLOT_ID, version: "unpinned" },
    inputs: [{ slot: "mode|reads|files", src: "hdca", id: "a1c62e0f5b3d7790" }],
    overrides: [],
    predicate: { kind: "manual" },
    ...over,
  });
}

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

/**
 * Galaxy's datatype hierarchy as usegalaxy.org's
 * `/api/datatypes/types_and_mapping` reports it, trimmed to the datatypes the
 * format tests use, and three of its converters.
 */
export const DATATYPES: DatatypesMapping = {
  ext_to_class_name: {
    data: "galaxy.datatypes.data.Data",
    txt: "galaxy.datatypes.data.Text",
    tabular: "galaxy.datatypes.tabular.Tabular",
    tsv: "galaxy.datatypes.tabular.TSV",
    csv: "galaxy.datatypes.tabular.CSV",
    fastq: "galaxy.datatypes.sequence.Fastq",
    "fastq.gz": "galaxy.datatypes.registry.FastqGz",
    "fastq.bz2": "galaxy.datatypes.registry.FastqBz2",
    fastqsanger: "galaxy.datatypes.sequence.FastqSanger",
    "fastqsanger.gz": "galaxy.datatypes.registry.FastqSangerGz",
    "fastqsanger.bz2": "galaxy.datatypes.registry.FastqSangerBz2",
    fasta: "galaxy.datatypes.sequence.Fasta",
    vcf_bgzip: "galaxy.datatypes.tabular.VcfGz",
    zip: "galaxy.datatypes.binary.CompressedZipArchive",
    bam: "galaxy.datatypes.binary.Bam",
  },
  class_to_classes: {
    "galaxy.datatypes.registry.FastqSangerBz2": {
      "galaxy.datatypes.binary.Binary": true,
      "galaxy.datatypes.binary.Bz2DynamicCompressedArchive": true,
      "galaxy.datatypes.binary.CompressedArchive": true,
      "galaxy.datatypes.binary.DynamicCompressedArchive": true,
      "galaxy.datatypes.data.Data": true,
      "galaxy.datatypes.data.Text": true,
      "galaxy.datatypes.registry.FastqSangerBz2": true,
      "galaxy.datatypes.sequence.BaseFastq": true,
      "galaxy.datatypes.sequence.Fastq": true,
      "galaxy.datatypes.sequence.FastqSanger": true,
      "galaxy.datatypes.sequence.Sequence": true,
    },
    "galaxy.datatypes.data.Data": {
      "galaxy.datatypes.data.Data": true,
    },
    "galaxy.datatypes.data.Text": {
      "galaxy.datatypes.data.Data": true,
      "galaxy.datatypes.data.Text": true,
    },
    "galaxy.datatypes.tabular.Tabular": {
      "galaxy.datatypes.data.Data": true,
      "galaxy.datatypes.data.Text": true,
      "galaxy.datatypes.tabular.Tabular": true,
      "galaxy.datatypes.tabular.TabularData": true,
    },
    "galaxy.datatypes.tabular.TSV": {
      "galaxy.datatypes.data.Data": true,
      "galaxy.datatypes.data.Text": true,
      "galaxy.datatypes.tabular.BaseCSV": true,
      "galaxy.datatypes.tabular.TSV": true,
      "galaxy.datatypes.tabular.TabularData": true,
    },
    "galaxy.datatypes.tabular.CSV": {
      "galaxy.datatypes.data.Data": true,
      "galaxy.datatypes.data.Text": true,
      "galaxy.datatypes.tabular.BaseCSV": true,
      "galaxy.datatypes.tabular.CSV": true,
      "galaxy.datatypes.tabular.TabularData": true,
    },
    "galaxy.datatypes.sequence.Fastq": {
      "galaxy.datatypes.data.Data": true,
      "galaxy.datatypes.data.Text": true,
      "galaxy.datatypes.sequence.BaseFastq": true,
      "galaxy.datatypes.sequence.Fastq": true,
      "galaxy.datatypes.sequence.Sequence": true,
    },
    "galaxy.datatypes.registry.FastqGz": {
      "galaxy.datatypes.binary.Binary": true,
      "galaxy.datatypes.binary.CompressedArchive": true,
      "galaxy.datatypes.binary.DynamicCompressedArchive": true,
      "galaxy.datatypes.binary.GzDynamicCompressedArchive": true,
      "galaxy.datatypes.data.Data": true,
      "galaxy.datatypes.data.Text": true,
      "galaxy.datatypes.registry.FastqGz": true,
      "galaxy.datatypes.sequence.BaseFastq": true,
      "galaxy.datatypes.sequence.Fastq": true,
      "galaxy.datatypes.sequence.Sequence": true,
    },
    "galaxy.datatypes.registry.FastqBz2": {
      "galaxy.datatypes.binary.Binary": true,
      "galaxy.datatypes.binary.Bz2DynamicCompressedArchive": true,
      "galaxy.datatypes.binary.CompressedArchive": true,
      "galaxy.datatypes.binary.DynamicCompressedArchive": true,
      "galaxy.datatypes.data.Data": true,
      "galaxy.datatypes.data.Text": true,
      "galaxy.datatypes.registry.FastqBz2": true,
      "galaxy.datatypes.sequence.BaseFastq": true,
      "galaxy.datatypes.sequence.Fastq": true,
      "galaxy.datatypes.sequence.Sequence": true,
    },
    "galaxy.datatypes.sequence.FastqSanger": {
      "galaxy.datatypes.data.Data": true,
      "galaxy.datatypes.data.Text": true,
      "galaxy.datatypes.sequence.BaseFastq": true,
      "galaxy.datatypes.sequence.Fastq": true,
      "galaxy.datatypes.sequence.FastqSanger": true,
      "galaxy.datatypes.sequence.Sequence": true,
    },
    "galaxy.datatypes.registry.FastqSangerGz": {
      "galaxy.datatypes.binary.Binary": true,
      "galaxy.datatypes.binary.CompressedArchive": true,
      "galaxy.datatypes.binary.DynamicCompressedArchive": true,
      "galaxy.datatypes.binary.GzDynamicCompressedArchive": true,
      "galaxy.datatypes.data.Data": true,
      "galaxy.datatypes.data.Text": true,
      "galaxy.datatypes.registry.FastqSangerGz": true,
      "galaxy.datatypes.sequence.BaseFastq": true,
      "galaxy.datatypes.sequence.Fastq": true,
      "galaxy.datatypes.sequence.FastqSanger": true,
      "galaxy.datatypes.sequence.Sequence": true,
    },
    "galaxy.datatypes.sequence.Fasta": {
      "galaxy.datatypes.data.Data": true,
      "galaxy.datatypes.data.Text": true,
      "galaxy.datatypes.sequence.Fasta": true,
      "galaxy.datatypes.sequence.Sequence": true,
    },
    "galaxy.datatypes.tabular.VcfGz": {
      "galaxy.datatypes.binary.Binary": true,
      "galaxy.datatypes.data.Data": true,
      "galaxy.datatypes.data.Text": true,
      "galaxy.datatypes.tabular.BaseVcf": true,
      "galaxy.datatypes.tabular.Tabular": true,
      "galaxy.datatypes.tabular.TabularData": true,
      "galaxy.datatypes.tabular.VcfGz": true,
    },
    "galaxy.datatypes.binary.CompressedZipArchive": {
      "galaxy.datatypes.binary.Binary": true,
      "galaxy.datatypes.binary.CompressedArchive": true,
      "galaxy.datatypes.binary.CompressedZipArchive": true,
      "galaxy.datatypes.data.Data": true,
    },
    "galaxy.datatypes.binary.Bam": {
      "galaxy.datatypes.binary.Bam": true,
      "galaxy.datatypes.binary.BamNative": true,
      "galaxy.datatypes.binary.Binary": true,
      "galaxy.datatypes.binary.CompressedArchive": true,
      "galaxy.datatypes.data.Data": true,
    },
  },
};

export const CONVERTERS = [
  { source: "fastqsanger.gz", target: "fastqsanger", tool_id: "CONVERTER_gz_to_uncompressed" },
  { source: "fastq.gz", target: "fastq", tool_id: "CONVERTER_gz_to_uncompressed" },
  { source: "tabular", target: "csv", tool_id: "tabular_to_csv" },
];

/** Scott's run manifest (#618): a TSV, not reads. */
export const MANIFEST_ID = "f9cad7b01a472135e3710fbaac96b25c";
