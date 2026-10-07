import * as fs from "fs";
import * as path from "path";
import { WORKSPACE_STATE_DIR_NAMES } from "../workspace-state-dir";
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
// Both brain config locations: a newer release may have copied the config
// into ~/.orbit, and this one reads it from there when it exists.
//
// The observation files are here for the same reason config.json is. The
// token store holds the retract tokens the intake route accepts as proof of
// ownership, and the outbox holds the install token that ties rows together --
// neither belongs in a model request. The sent log carries neither token, but
// it is the user's record of what they reported and is read through
// /observations, not by the agent.
const SENSITIVE_HOME_FILES = [
  ".netrc",
  ".loom/config.json",
  ".orbit/config.json",
  ".loom/observations-tokens.json",
  ".orbit/observations-tokens.json",
  ".loom/observations-outbox.jsonl",
  ".orbit/observations-outbox.jsonl",
  ".loom/observations-sent.jsonl",
  ".orbit/observations-sent.jsonl",
  ".pgpass",
  ".npmrc",
];
// Files inside pi's agent dir that hold live credentials. auth.json is pi's
// CredentialStore -- an api-key `key`, or an OAuth access+refresh pair; mcp.json
// and galaxy-profiles.json carry Galaxy keys. These want the floor more than
// the config.json entries above, not less: those are safeStorage blobs, but pi
// reads these directly and refreshes auth.json in place (app/src/main/
// oauth-handler.ts), so Orbit cannot encrypt them and this is the only
// protection they get. Listed separately from SENSITIVE_HOME_FILES because the
// whole directory relocates with PI_CODING_AGENT_DIR and is then not under
// $HOME at all. models.json holds the env var NAME rather than the secret, and
// models-store.json is a refreshed provider catalog, so both stay readable.
const AGENT_DIR_CREDENTIAL_FILES = ["auth.json", "mcp.json", "galaxy-profiles.json"];
// Basename / extension patterns sensitive anywhere.
const SENSITIVE_BASENAME =
  /^(\.env(\..+)?|id_rsa|id_ed25519|id_ecdsa|.*\.pem|.*\.key|.*\.keychain(-db)?|credentials)$/i;

function within(abs: string, dir: string): boolean {
  const rel = path.relative(dir, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * `within`, case-folded. Only the credential-store lists use it.
 *
 * macOS is case-insensitive and its realpath does not normalize case, so
 * `Library/Keychains` and `library/keychains` name one directory that an
 * exact-case list only half-covers -- `library/keychains/user.kb` walked
 * straight past this check. Folding can over-match a literally lowercase
 * `library/keychains` on Linux, which errs toward refusing a read, and that is
 * the safe direction for a list whose whole purpose is credential stores.
 *
 * Deliberately NOT used by the write-protection carve-out below: there a match
 * means "this is an analysis workspace, so allow the write", and folding would
 * widen an exemption rather than a refusal.
 */
function withinFolded(abs: string, dir: string): boolean {
  return within(abs.toLowerCase(), dir.toLowerCase());
}

// Dedicated credential stores: the home-relative dirs and exact files above
// that exist solely to hold secrets. The agent has no legitimate reason to read
// their CONTENTS, so reads are denied for every model tier (not just downgraded
// to an ask). This is the floor that closes #183 -- ~/.loom/config.json is a
// store. The basename patterns (.env, *.pem, *.key, ...) are deliberately NOT
// stores: those can be project fixtures, so they keep the ask/deny-by-tier path.
// `agentDir` is injected so tests can relocate the store the same way
// PI_CODING_AGENT_DIR does in a real run; the default resolves it exactly as
// the rest of Loom does.
export function isCredentialStore(
  absPath: string,
  home: string,
  agentDir: string = piAgentDir(),
): boolean {
  const norm = path.normalize(absPath);
  for (const d of SENSITIVE_HOME_DIRS) if (withinFolded(norm, path.join(home, d))) return true;
  // Also as realpaths: callers compare resolved targets, so a config.json that
  // is itself a symlink into the workspace would otherwise read as a plain
  // workspace file.
  return credentialFileCandidates(home, agentDir).has(norm.toLowerCase());
}

interface CandidateSnapshot {
  candidates: Set<string>;
  watched: Map<string, string>;
  // False while any watched dir changed too recently for its mtime to have
  // moved on; see RACY_WINDOW_MS.
  settled: boolean;
}

const candidateCache = new Map<string, CandidateSnapshot>();
const CANDIDATE_CACHE_LIMIT = 16;

// A modification in the same timestamp tick as the one a snapshot saw leaves
// the mtime unchanged (Linux stamps from a coarse jiffy clock, HFS+ to the
// second), so a snapshot taken within this long of a watched dir's mtime is
// rebuilt on the next call instead of trusted. Same idea as git's racy-index
// check.
const RACY_WINDOW_MS = 1000;

/**
 * Every spelling of every credential file, lexical and resolved, lowercased.
 *
 * Every file read and every directory listing entry on the web surface comes
 * through here, and resolving each file costs one or two realpath walks --
 * slow enough on Windows to matter -- so the set is cached per (home,
 * agentDir). The cache is keyed on the stat of each candidate's parent
 * directory and of every directory between it and $HOME. What a candidate
 * resolves to can only change when an entry on that path is created, removed,
 * renamed or replaced, and each of those rewrites the containing directory and
 * so bumps its mtime -- on APFS, ext4 and NTFS alike. A symlink planted at
 * `~/.loom/config.json` therefore shows up on the very next call. A symlink's
 * target cannot be edited in place on POSIX; it has to be recreated, which is
 * again a directory change. The inode rides along in the signature so a
 * directory swapped for another with the same mtime still invalidates.
 */
function credentialFileCandidates(home: string, agentDir: string): Set<string> {
  // No home: the lexical relative paths, exactly as before, and nothing on
  // disk worth caching against.
  if (!home) {
    const lexical = SENSITIVE_HOME_FILES.map((f) => path.join(home, f));
    for (const f of AGENT_DIR_CREDENTIAL_FILES) {
      const p = path.join(agentDir, f);
      lexical.push(...withRealpath(p, new Map(), isSymlink(p)));
    }
    return new Set(lexical.map((c) => c.toLowerCase()));
  }

  const key = `${home}\0${agentDir}`;
  const cached = candidateCache.get(key);
  if (cached?.settled && signaturesMatch(cached.watched)) return cached.candidates;

  const builtAt = Date.now();
  const files = [
    ...SENSITIVE_HOME_FILES.map((f) => path.join(home, f)),
    ...AGENT_DIR_CREDENTIAL_FILES.map((f) => path.join(agentDir, f)),
  ];
  // Stat the watched dirs BEFORE resolving, so a change that lands mid-build
  // leaves a stale signature behind and forces the next call to rebuild.
  const watched = new Map<string, string>();
  for (const f of files) {
    for (const dir of dirsToWatch(path.dirname(f), home)) {
      if (!watched.has(dir)) watched.set(dir, dirSignature(dir));
    }
  }
  const resolvedParents = new Map<string, string | null>();
  const candidates = new Set<string>();
  let sawLink = false;
  for (const f of files) {
    const link = isSymlink(f);
    if (link) sawLink = true;
    for (const c of withRealpath(f, resolvedParents, link)) candidates.add(c.toLowerCase());
  }
  // A parent that is itself a symlink resolves elsewhere; statSync above
  // already follows it, but watch the resolved dir under its own name too so
  // a later swap of the link is not hidden behind a cached signature.
  for (const real of resolvedParents.values()) {
    if (real && !watched.has(real)) watched.set(real, dirSignature(real));
  }
  // A credential file that is itself a symlink resolves through directories
  // nobody is watching, and a dangling one starts resolving the moment its
  // target is created, so that snapshot is never trusted: rare enough that
  // paying the full walk on every call is fine.
  const settled =
    !sawLink &&
    [...watched.values()].every((sig) => {
      const mtime = Number(sig.split(":")[0]);
      return Number.isNaN(mtime) || mtime < builtAt - RACY_WINDOW_MS;
    });

  if (candidateCache.size >= CANDIDATE_CACHE_LIMIT && !candidateCache.has(key)) {
    candidateCache.clear();
  }
  candidateCache.set(key, { candidates, watched, settled });
  return candidates;
}

// The parent itself, then each ancestor up to and including $HOME. Swapping
// `~/.loom` for a symlink changes `~`, not `~/.loom`. A dir outside $HOME (a
// relocated agent dir) gets itself and its own parent. Ancestors above $HOME
// are not watched: replacing those needs rights over the home directory
// itself, at which point nothing here holds anyway.
function dirsToWatch(dir: string, home: string): string[] {
  const out = [dir];
  if (!within(dir, home)) {
    out.push(path.dirname(dir));
    return out;
  }
  // Compared with `within` rather than `===` so a home spelled with a
  // trailing separator still stops the walk at $HOME.
  for (let cur = dir; cur !== path.dirname(cur) && within(path.dirname(cur), home);) {
    cur = path.dirname(cur);
    out.push(cur);
  }
  return out;
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function dirSignature(dir: string): string {
  try {
    const st = fs.statSync(dir);
    return `${st.mtimeMs}:${st.ino}`;
  } catch {
    return "absent";
  }
}

function signaturesMatch(watched: Map<string, string>): boolean {
  for (const [dir, sig] of watched) if (dirSignature(dir) !== sig) return false;
  return true;
}

// A path both as written and as resolved, since callers hand us realpaths. Only
// a file that is itself a symlink needs its own realpath; anything else
// resolves through its parent, which is resolved once per directory and shared
// through `resolvedParents`. That also covers a file that doesn't exist yet.
function withRealpath(
  p: string,
  resolvedParents: Map<string, string | null>,
  isLink: boolean,
): string[] {
  const out = [p];
  if (isLink) {
    try {
      out.push(fs.realpathSync(p));
      return out;
    } catch {
      /* dangling -- the parent-resolved spelling is still worth having */
    }
  }
  const dir = path.dirname(p);
  if (!resolvedParents.has(dir)) {
    let real: string | null = null;
    try {
      real = fs.realpathSync(dir);
    } catch {
      /* nothing on disk yet -- the lexical path is all there is */
    }
    resolvedParents.set(dir, real);
  }
  const realDir = resolvedParents.get(dir);
  if (realDir) out.push(path.join(realDir, path.basename(p)));
  return out;
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
// a state dir (`.loom` or `.orbit` -- Loom's own session state) should never be
// written by the model silently -- it uses git commands for repo ops, not the
// write tool.
//
// `home` enables the one carve-out we need: Orbit files analyses under
// $HOME/.loom/analyses/<name>/ (and, after the rename, $HOME/.orbit/analyses),
// so those workspaces sit under a state-dir segment yet are the agent's actual
// work product, not Loom state. Writes there are allowed -- but a *nested*
// `.git`/`.loom`/`.orbit` inside an analysis (a real repo's hooks, or the
// per-workspace state dir) stays protected. Everything else with a `.git` or
// state-dir segment -- Loom's home state, some other repo's .git, a
// per-workspace state dir outside the analyses tree, or a path whose cwd
// happens to sit inside one -- stays gated. `.git` is never carved out: a
// workspace is never legitimately inside one. Pass home="" for the plain
// absolute check (callers without a home / the unit tests).
export function isProtectedWritePath(absPath: string, home = ""): boolean {
  if (hasSegment(path.normalize(absPath), ".git")) return true;
  return isLoomStatePath(absPath, home);
}

// Both spellings are state in every workspace, whichever one it actually uses:
// a `.loom` workspace must not leave a sibling `.orbit` writable, or the other
// way round.
function hasStateSegment(p: string): boolean {
  return WORKSPACE_STATE_DIR_NAMES.some((name) => hasSegment(p, name));
}

// Loom's own state: a path with a state-dir segment that is NOT the analyses
// tree Orbit hands the agent as a workspace. Split out of isProtectedWritePath
// so the bash classifier can reuse exactly this carve-out without also
// inheriting the `.git` rule -- a `.git` write through bash is an ordinary
// unrecognized command, not a catastrophic one. (home is compared
// un-realpath'd, matching isSensitivePath; pass home="" for the plain absolute
// check.)
export function isLoomStatePath(absPath: string, home = ""): boolean {
  const norm = path.normalize(absPath);
  if (!hasStateSegment(norm)) return false;
  // A home that itself sits under a state dir gets no carve-out: the segment
  // above it is state no matter which analyses tree the path is in.
  if (home && !hasStateSegment(path.normalize(home))) {
    for (const name of WORKSPACE_STATE_DIR_NAMES) {
      const analyses = path.join(home, name, "analyses");
      if (within(norm, analyses) && !hasStateSegment(path.relative(analyses, norm))) {
        return false;
      }
    }
  }
  return true;
}
