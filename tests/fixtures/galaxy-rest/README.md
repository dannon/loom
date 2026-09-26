# Galaxy REST fixtures for the harness's own submissions

The calls in `galaxy-api.ts` that let the harness submit gated work itself
(`galaxyRunTool`, `galaxyRunUserTool`, `galaxyInvokeWorkflow`,
`galaxyCreateHistory`) and fetch what it freezes at approval
(`galaxyGetToolInputTemplate`, `galaxyGetWorkflowInputTemplate`,
`galaxyGetUserToolDefinition`).

## Recorded

Fetched anonymously from usegalaxy.org on 2026-09-26. Nothing here belongs to a
Loom user.

| file                                    | request                                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `tool-cat1.io-details.json`             | `GET /api/tools/cat1?io_details=true`                                                                                  |
| `workflow-bigwig-average.run-form.json` | `GET /api/workflows/97ed37bc0e78b990/download?style=run&instance=false` (IWC "BigWig Replicates Averaging", published) |

## Constructed

The run and create endpoints need an authenticated account and create real jobs
and histories, so their responses are built rather than recorded:
`run-tool.response.json` is BioBlend 1.9.0's documented `run_tool` example
trimmed to the fields we read; the invocation, history, and user-defined tool
responses follow Galaxy's `WorkflowInvocationResponse`, `HistorySummary`, and
`UnprivilegedToolResponse` models with made-up ids. The tests read only ids and
states from them.

## Golden requests

`golden/*.request.json` is the exact method, URL, and body each submission call
sends. They match what galaxy-mcp 1.10.0 sends through BioBlend 1.9.0 for the
same call, except that the tool version is always present and the workflow
payload pins `instance: false`, `require_exact_tool_versions: true`, and no
state corrections. Change one of these files only on purpose: a diff here is a
change to what runs on Galaxy.
