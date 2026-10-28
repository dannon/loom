/**
 * How a shell names its Galaxy tools to the model, so a guard can ask "is this
 * run_tool?" without knowing which tools that shell registered. Every shell
 * runs galaxy-ops in-process under the operations' own names (`run_tool`,
 * `get_dataset_details`, ...); Loom's own Galaxy tools (galaxy_job_record,
 * galaxy_upload_local_file, ...) are a different family and keep their names.
 *
 * @typedef {object} GalaxyToolFamily
 * @property {(tool: string) => string} tool the model-facing name for a Galaxy tool
 * @property {(toolName: string | undefined) => string | undefined} toolName
 *   the Galaxy tool behind a model-facing name, or undefined when it isn't one
 */

/**
 * Bare names carry no marker, so a family has to be told which names are
 * Galaxy's; anything else (bash, read, a shell's own tools) isn't Galaxy.
 *
 * @param {Iterable<string>} tools the Galaxy tool names the shell registered
 * @returns {Readonly<GalaxyToolFamily>}
 */
export function bareFamily(tools) {
  const known = new Set(tools);
  return Object.freeze({
    tool: (tool) => tool,
    toolName: (toolName) => (toolName !== undefined && known.has(toolName) ? toolName : undefined),
  });
}
