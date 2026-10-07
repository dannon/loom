// pi 1.0 exits on `--provider` without `--model`; pi 0.85 accepted a bare
// --provider and picked a model on its own. Loom passes a provider with no model
// whenever nothing names one -- a provider saved with a key but no model, or the
// web shell's bring-your-own-key path, which only knows the provider -- so those
// launches need the model pi itself defaults to for that provider.

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * pi keeps its per-provider defaults in a module its exports map doesn't list,
 * so load it by file path next to the package entry point. The entry point only
 * has an "import" condition, so it has to be resolved the ESM way.
 * @param {(specifier: string) => string} [resolveSpecifier] returns a file URL
 *   or path; injectable for tests
 * @returns {Promise<Record<string, string>>}
 */
export async function loadPiDefaultModels(resolveSpecifier = (s) => import.meta.resolve(s)) {
  try {
    const resolved = resolveSpecifier("@earendil-works/pi-coding-agent");
    const entry = resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
    const mod = await import(pathToFileURL(join(dirname(entry), "core/model-resolver.js")).href);
    return mod.defaultModelPerProvider ?? {};
  } catch {
    return {};
  }
}

/**
 * pi's default model for `provider` (matched case-insensitively, as pi does),
 * or undefined. Undefined leaves --provider bare, which pi refuses: better a
 * clear startup error than falling through to some other provider's account.
 * @param {string | undefined} provider
 * @param {Record<string, string>} defaults
 * @returns {string | undefined}
 */
export function piDefaultModel(provider, defaults) {
  if (!provider) return undefined;
  const key = Object.keys(defaults).find((k) => k.toLowerCase() === provider.toLowerCase());
  return key ? defaults[key] : undefined;
}
