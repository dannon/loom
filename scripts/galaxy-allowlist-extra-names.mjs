// Galaxy tool names the observation allowlist carries beyond galaxy-ops'
// allOperations. Empty since the Python galaxy-mcp server went: its connect tool
// and code-mode meta-tools (search, get_schemas, run_galaxy_tool) have no caller
// left, and every Galaxy tool a shell offers is a galaxy-ops operation. A name
// goes here only when a shell offers a Galaxy tool galaxy-ops lacks.
//
// Shared by scripts/gen-observation-allowlists.mjs and the test that checks the
// generated list against the installed galaxy-ops.
export const GALAXY_ALLOWLIST_EXTRA_NAMES = Object.freeze([]);
