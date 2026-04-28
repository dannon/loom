# Loom Pitch

Loom is a Galaxy co-scientist shell that keeps analysis work reproducible without making the shell the source of truth.

The current runtime is intentionally simple:

- `notebook.md` in the analysis directory is the durable working record.
- Galaxy histories remain the computational truth.
- Galaxy invocation status is tracked in `loom-invocation` fenced YAML blocks inside the notebook.
- Orbit, the CLI, and future shells stay thin; the brain and shared contracts live outside shell-specific UI code.

## Why It Exists

Agentic bioinformatics can produce useful work, but the failure mode is familiar: decisions happen in chat, parameters drift, provenance is reconstructed after the fact, and a plausible final answer hides weak intermediate validation.

Loom makes the working record explicit while the analysis is happening. Plans, parameter tables, execution notes, interpretation, and follow-up questions are written to a notebook the researcher can inspect, edit, diff, and share.

## Current Workflow

1. The researcher starts Loom in an analysis directory.
2. Loom creates or opens `notebook.md`.
3. The researcher asks for exploration, a plan, execution, interpretation, or publication help.
4. For multi-step plans, the agent drafts in chat first, waits for plan approval, shows parameters, waits for parameter approval, then edits the notebook.
5. Galaxy work runs through Galaxy MCP by default when credentials are available.
6. Completed Galaxy invocations are recorded as `loom-invocation` blocks and updated by polling tools.

The approval sequence is model guidance, not a hard runtime gate. The notebook is still user-editable markdown, and manual override is allowed when the researcher explicitly asks for it.

## Why Markdown Plus Blocks

Plain markdown keeps the record inspectable and easy to edit. Small structured fenced blocks handle the parts that need stable identity and programmatic updates.

The existing `loom-invocation` block is the pattern for follow-up work:

- research question blocks
- literature blocks
- BRC context blocks
- parameter override blocks
- assertion and QC blocks
- tool-version blocks
- methods-generation inputs

These blocks keep the notebook as the source of truth while giving future Galaxy Page sync a clean section-level mapping.

## Direction

The next architectural step is not to restore in-memory plan state. It is to restore useful structured emitters as notebook-resident fenced blocks, then sync those blocks into Galaxy Pages through the shared Galaxy operations layer.

That keeps Loom aligned with the broader Galaxy ecosystem: Galaxy is the substrate, Page is the shareable artifact, and Loom is one live authoring shell.
