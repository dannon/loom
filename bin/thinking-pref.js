// Terminal "thinking block" visibility. Pi streams the model's reasoning into
// the interactive TUI by default, which makes the Orbit terminal noisy. Orbit
// hides it by default and writes the resolved value to pi's `hideThinkingBlock`
// setting (the same ~/.pi/agent/settings.json Orbit already manages for
// `quietStartup`). That setting is global and only the interactive renderer
// reads it, so bin/orbit.js only reconciles it for interactive terminal launches.
//
// Override the default persistently with `ui.showThinking: true` in
// ~/.orbit/config.json; for a one-off, pi's built-in Ctrl+T toggles it live.
//
// Pure so it can be unit-tested; bin/orbit.js supplies the config value.

/**
 * Resolve whether pi should hide thinking blocks in the terminal.
 * @param {{ configShowThinking?: boolean }} [opts] `ui.showThinking` from ~/.orbit/config.json
 * @returns {boolean} true = hide (the default); false = show (config opted in)
 */
export function resolveHideThinking({ configShowThinking } = {}) {
  return configShowThinking !== true;
}

/**
 * Is this Orbit launch an interactive terminal TUI? `hideThinkingBlock` only
 * affects pi's interactive renderer, so non-interactive launches must not
 * write it (it would churn the global settings file for a setting they never
 * read): `--mode rpc` (Orbit and the web dev server), `--mode json` (evals),
 * and headless `--print` / `-p`. Gating on the mode rather than a per-spawner
 * env var means new non-interactive callers are covered automatically.
 * @param {string[]} [argv] the CLI user args (process.argv.slice(2))
 * @returns {boolean}
 */
export function isInteractiveTerminal(argv = []) {
  if (argv.includes("--print") || argv.includes("-p")) return false;
  const i = argv.indexOf("--mode");
  const mode =
    i !== -1 ? argv[i + 1] : argv.find((a) => a.startsWith("--mode="))?.slice("--mode=".length);
  return mode !== "rpc" && mode !== "json";
}
