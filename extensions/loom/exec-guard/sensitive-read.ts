import * as path from "path";
import { piAgentDir } from "../agent-dir";

// Directories under $HOME that hold credentials/secrets.
const SENSITIVE_HOME_DIRS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gcloud",
  ".kube",
  ".docker",
  "Library/Keychains",
];
// Exact files under $HOME.
const SENSITIVE_HOME_FILES = [".netrc", ".loom/config.json", ".pgpass", ".npmrc"];
// Files inside pi's agent dir that hold live credentials. auth.json is pi's
// CredentialStore -- an api-key `key`, or an OAuth access+refresh pair; mcp.json
// and galaxy-profiles.json carry Galaxy keys. These matter more than their
// $HOME counterparts, not less: ~/.loom/config.json is a safeStorage blob, but
// pi reads these directly and runs its own OAuth refresh against auth.json, so
// Orbit cannot encrypt them (see app/src/main/oauth-handler.ts). This floor is
// the only protection they have. models.json holds the env var NAME rather than
// the secret and models-store.json is a provider catalog, so both stay readable.
const AGENT_DIR_CREDENTIAL_FILES = ["auth.json", "mcp.json", "galaxy-profiles.json"];
// Basename / extension patterns sensitive anywhere.
const SENSITIVE_BASENAME =
  /^(\.env(\..+)?|id_rsa|id_ed25519|id_ecdsa|.*\.pem|.*\.key|.*\.keychain(-db)?|credentials)$/i;

// Case-folded path equality, for the same reason hasSegment folds below: macOS
// resolves ~/.PI/agent/AUTH.JSON to the same file and realpath does not
// normalize case. Over-matching on a case-sensitive filesystem errs toward
// protection. (The $HOME arms below still compare exactly -- a pre-existing gap
// that wants its own change, since widening them touches every rule at once.)
function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function within(abs: string, dir: string): boolean {
  const rel = path.relative(dir, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Dedicated credential stores: the home-relative dirs and exact files above
// that exist solely to hold secrets. The agent has no legitimate reason to read
// their CONTENTS, so reads are denied for every model tier (not just downgraded
// to an ask). This is the floor that closes #183 -- ~/.loom/config.json is a
// store. The basename patterns (.env, *.pem, *.key, ...) are deliberately NOT
// stores: those can be project fixtures, so they keep the ask/deny-by-tier path.
// `agentDir` is injected so the check follows PI_CODING_AGENT_DIR (tests and
// custom setups relocate the whole store); the default resolves it the same way
// the rest of Loom does.
export function isCredentialStore(
  absPath: string,
  home: string,
  agentDir: string = piAgentDir(),
): boolean {
  const norm = path.normalize(absPath);
  for (const d of SENSITIVE_HOME_DIRS) if (within(norm, path.join(home, d))) return true;
  for (const f of SENSITIVE_HOME_FILES) if (norm === path.join(home, f)) return true;
  for (const f of AGENT_DIR_CREDENTIAL_FILES)
    if (samePath(norm, path.join(agentDir, f))) return true;
  return false;
}

export function isSensitivePath(absPath: string, home: string, agentDir?: string): boolean {
  if (isCredentialStore(absPath, home, agentDir)) return true;
  if (SENSITIVE_BASENAME.test(path.basename(path.normalize(absPath)))) return true;
  return false;
}

// Case-folded path-segment membership. macOS HFS+ is case-insensitive and
// realpath does not normalize case there, so `.Git` / `.LOOM` would otherwise
// dodge the check. Folding may over-match a literal `.Git` dir on case-sensitive
// Linux, but that errs toward protection.
function hasSegment(p: string, name: string): boolean {
  return p.split(path.sep).some((s) => s.toLowerCase() === name);
}

// Write targets gated even inside the workspace jail. A file under `.git`
// (hooks run on the next git operation; config can redirect hooksPath) or under
// `.loom` (Loom's own session state) should never be written by the model
// silently -- it uses git commands for repo ops, not the write tool.
//
// `home` enables the one carve-out we need: Orbit files analyses under
// $HOME/.loom/analyses/<name>/, so those workspaces sit under a `.loom` segment
// yet are the agent's actual work product, not Loom state. Writes there are
// allowed -- but a *nested* `.git`/`.loom` inside an analysis (a real repo's
// hooks, or the per-workspace activity log) stays protected. Everything else
// with a `.git`/`.loom` segment -- Loom's home state, some other repo's .git, a
// per-workspace .loom outside the analyses tree, or a path whose cwd happens to
// sit inside a .git/.loom dir -- stays gated. `.git` is never carved out: a
// workspace is never legitimately inside one. Pass home="" for the plain
// absolute check (callers without a home / the unit tests).
export function isProtectedWritePath(absPath: string, home = ""): boolean {
  if (hasSegment(path.normalize(absPath), ".git")) return true;
  return isLoomStatePath(absPath, home);
}

// Loom's own state: a path with a `.loom` segment that is NOT the analyses tree
// Orbit hands the agent as a workspace. Split out of isProtectedWritePath so the
// bash classifier can reuse exactly this carve-out without also inheriting the
// `.git` rule -- a `.git` write through bash is an ordinary unrecognized command,
// not a catastrophic one. (home is compared un-realpath'd, matching
// isSensitivePath; pass home="" for the plain absolute check.)
export function isLoomStatePath(absPath: string, home = ""): boolean {
  const norm = path.normalize(absPath);
  if (!hasSegment(norm, ".loom")) return false;
  if (home) {
    const analyses = path.join(home, ".loom", "analyses");
    if (within(norm, analyses) && !hasSegment(path.relative(analyses, norm), ".loom")) {
      return false;
    }
  }
  return true;
}
