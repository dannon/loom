// pi drops providers between releases (1.1.0 removed ollama, #598), and a
// config saved under an older Loom still names them. pi rejects an unknown
// --provider with a plain exit 1, which a shell reads as a crash and retries --
// so the brain checks first and exits EX_CONFIG with a message instead.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Provider names declared in pi's models.json. pi resolves --provider against
 * these as well as its built-ins, so a legacy custom provider stays valid.
 * @param {string} modelsPath
 * @returns {string[]}
 */
export function modelsJsonProviders(modelsPath) {
  if (!existsSync(modelsPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(modelsPath, "utf-8"));
    const providers = parsed?.providers;
    return providers && typeof providers === "object" ? Object.keys(providers) : [];
  } catch {
    return [];
  }
}

const nonEmptyDir = (dir) => {
  try {
    // Dotfiles (.DS_Store, .gitkeep) aren't extensions.
    return readdirSync(dir).some((f) => !f.startsWith("."));
  } catch {
    return false;
  }
};

const settingsLoadsCode = (path) => {
  try {
    const s = JSON.parse(readFileSync(path, "utf-8"));
    return [s?.packages, s?.extensions].some((v) => Array.isArray(v) && v.length > 0);
  } catch {
    return false;
  }
};

/**
 * Could a pi extension register providers we can't see from here? pi loads
 * extensions from these places after startup, and any of them can call
 * registerProvider -- so with one present, an unrecognized name isn't proof.
 * @param {string} agentDir
 * @param {string} cwd
 */
export function userExtensionsMayRegisterProviders(agentDir, cwd) {
  const projectDir = join(cwd, ".pi");
  return (
    nonEmptyDir(join(agentDir, "extensions")) ||
    nonEmptyDir(join(projectDir, "extensions")) ||
    settingsLoadsCode(join(agentDir, "settings.json")) ||
    settingsLoadsCode(join(projectDir, "settings.json"))
  );
}

/**
 * Would pi accept `provider` as --provider? Case-insensitive, as pi matches.
 * @param {string} provider
 * @param {Iterable<string>} builtIn pi-ai's getProviders()
 * @param {Iterable<string>} [extra] names from models.json
 */
export function isKnownProvider(provider, builtIn, extra = []) {
  const wanted = provider.toLowerCase();
  for (const name of [...builtIn, ...extra]) {
    if (name.toLowerCase() === wanted) return true;
  }
  return false;
}

/**
 * What the brain prints before exiting EX_CONFIG on an unknown provider.
 * Mentions the custom-endpoint route because the provider that triggered this
 * (ollama) is still reachable that way.
 * @param {string} provider
 */
export function unknownProviderMessage(provider) {
  return `loom: provider "${provider}" isn't supported by this version of Loom, so the
agent can't start with it.

Open Preferences and pick another provider. If this was a local server
(Ollama, llama.cpp), set it up as an "OpenAI-compatible endpoint" with its
base URL instead (e.g. http://127.0.0.1:11434/v1).
`;
}
