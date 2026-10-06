/**
 * How Galaxy MCP tools are named on the pi side.
 *
 * pi's built-in MCP registers each server tool as `mcp__<server>__<tool>`, so
 * galaxy-mcp's `run_tool` reaches the model as `mcp__galaxy__run_tool`. Loom's
 * own Galaxy tools (galaxy_job_record, galaxy_upload_local_file, ...) are a
 * different family and keep their names.
 */
export const GALAXY_MCP_PREFIX = "mcp__galaxy__";

/** The pi tool name for a galaxy-mcp tool. @param {string} tool @returns {string} */
export function galaxyMcpTool(tool) {
  return GALAXY_MCP_PREFIX + tool;
}

/**
 * The galaxy-mcp tool behind a pi tool name, or undefined when it isn't one.
 * @param {string | undefined} toolName @returns {string | undefined}
 */
export function galaxyMcpToolName(toolName) {
  if (!toolName?.startsWith(GALAXY_MCP_PREFIX)) return undefined;
  const tool = toolName.slice(GALAXY_MCP_PREFIX.length);
  // Another server can share the prefix: "galaxy_" or "galaxy-" gives
  // mcp__galaxy___<tool>, "galaxy__x" gives mcp__galaxy__x__<tool>. galaxy-mcp's
  // own names never start with "_" or contain "__".
  return tool && !tool.startsWith("_") && !tool.includes("__") ? tool : undefined;
}

/** @param {string | undefined} toolName @returns {boolean} */
export function isGalaxyMcpTool(toolName) {
  return galaxyMcpToolName(toolName) !== undefined;
}
