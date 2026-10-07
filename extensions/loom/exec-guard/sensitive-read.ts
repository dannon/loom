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
  watched: Map<string, DirSignature>;
  // Each symlink the walk followed, signed as the link itself.
  links: Map<string, DirSignature>;
  // False while any watched dir changed too recently to trust; see
  // RACY_WINDOW_MS.
  settled: boolean;
}

interface DirSignature {
  key: string;
  changedAt: number;
}

const candidateCache = new Map<string, CandidateSnapshot>();
const CANDIDATE_CACHE_LIMIT = 16;

// A change in the same timestamp tick as one a snapshot already saw leaves the
// stamps unchanged (Linux stamps from a coarse jiffy clock, HFS+ to the
// second), so a snapshot taken within this long of a watched dir changing is
// rebuilt on the next call instead of trusted. The same window catches a
// change that lands in a resolved dir between resolving it and statting it.
// Same idea as git's racy-index check.
const RACY_WINDOW_MS = 1000;

/**
 * Every spelling of every credential file, lexical and resolved, lowercased.
 *
 * Every file read and every directory listing entry on the web surface comes
 * through here, and resolving each file costs one or two realpath walks --
 * slow enough on Windows to matter -- so the set is cached per (home,
 * agentDir). The cache is keyed on an lstat of every directory whose entries
 * the resolution depended on: each one a candidate's parent is walked through
 * component by component, including the dir that holds each symlink along the
 * way and every dir that link's target passes through in turn (see
 * watchResolution). What a candidate resolves to can only change when an
 * entry in one of those dirs is created, removed, renamed or replaced, and
 * each of those rewrites that dir -- so a symlink planted at
 * `~/.loom/config.json`, a renamed ancestor relinked to its old name, or a
 * link halfway down the chain re-pointed somewhere else all show up on the
 * very next call. ctime is in the signature because mtime alone can be put
 * back with `touch -r`, and no ordinary file call can set ctime.
 *
 * A settled snapshot never re-checks its own age, so a clock set backwards
 * far enough to reproduce an old mtime:ctime:ino tuple would go unnoticed.
 * That's accepted: whoever can roll back the clock is outside what this
 * guards against, and the racy window is only about time moving forward.
 */
function credentialFileCandidates(home: string, agentDir: string): Set<string> {
  // No home: the lexical relative paths, exactly as before. They resolve
  // against the cwd, so there's nothing stable to cache them under.
  if (!home) {
    const lexical = SENSITIVE_HOME_FILES.map((f) => path.join(home, f));
    const resolvedParents = new Map<string, ResolvedDir>();
    for (const f of AGENT_DIR_CREDENTIAL_FILES) {
      const p = path.join(agentDir, f);
      lexical.push(...withRealpath(p, resolvedParents, isSymlink(p)));
    }
    return new Set(lexical.map((c) => c.toLowerCase()));
  }

  // Keyed on the absolute dirs: PI_CODING_AGENT_DIR may be relative, and a
  // snapshot of a relative dir would outlive a chdir. The candidates keep the
  // spellings as given too, since on Windows resolving a drive-less home
  // prepends the cwd's drive and callers may still pass the drive-less form.
  const absHome = path.resolve(home);
  const absAgentDir = path.resolve(agentDir);
  const key = JSON.stringify([absHome, absAgentDir]);
  const cached = candidateCache.get(key);
  if (cached?.settled && signaturesMatch(cached.watched) && signaturesMatch(cached.links)) {
    return cached.candidates;
  }

  const builtAt = Date.now();
  const files = [
    ...SENSITIVE_HOME_FILES.map((f) => path.join(home, f)),
    ...AGENT_DIR_CREDENTIAL_FILES.map((f) => path.join(agentDir, f)),
  ];
  const candidates = new Set<string>();
  if (absHome !== home) for (const f of SENSITIVE_HOME_FILES) addFolded(candidates, absHome, f);
  if (absAgentDir !== agentDir) {
    for (const f of AGENT_DIR_CREDENTIAL_FILES) addFolded(candidates, absAgentDir, f);
  }
  // Walk (and so sign) every dir BEFORE realpath resolves it, so a change
  // that lands mid-build leaves a stale signature behind and forces the next
  // call to rebuild.
  const walk: WalkState = { watched: new Map(), links: new Map(), targets: new Map() };
  const parents = new Map<string, Walk>();
  for (const f of files) {
    const dir = path.dirname(f);
    if (!parents.has(dir)) parents.set(dir, watchResolution(dir, walk));
  }
  const { watched, links } = walk;
  const resolvedParents = new Map<string, ResolvedDir>();
  let sawLink = false;
  for (const f of files) {
    const link = isSymlink(f);
    if (link) sawLink = true;
    for (const c of withRealpath(f, resolvedParents, link, parents)) {
      candidates.add(c.toLowerCase());
    }
  }
  // realpath decides the spellings, since that's what callers compare against;
  // the walk only decides what to watch. If it disagrees with fs.realpathSync
  // -- a race, or some platform quirk the walk doesn't model -- the watched
  // set may be the wrong one, so don't trust it.
  //
  // The native realpath is not compared. The one place it lands somewhere
  // else, a `..` in a link target, already leaves the walk incomplete, and off
  // Windows it isn't even computed when the walk agrees. On Windows it also
  // expands 8.3 short names (`RUNNER~1`) and subst or mapped drives that
  // fs.realpathSync and the walk keep as given -- another spelling of the same
  // dirs, which the candidates already carry -- and comparing it left every
  // such home rebuilding on every call.
  let walksAgree = true;
  for (const [dir, w] of parents) {
    if (!w.complete || w.real !== (resolvedParents.get(dir)?.js ?? null)) walksAgree = false;
  }
  // A credential file that is itself a symlink resolves through its target's
  // dirs, and a dangling one starts resolving the moment its target is
  // created, so that snapshot is never trusted: rare enough that paying the
  // full walk on every call is fine.
  const settled =
    walksAgree &&
    !sawLink &&
    [...watched.values()].every((sig) => sig.changedAt < builtAt - RACY_WINDOW_MS);

  if (candidateCache.size >= CANDIDATE_CACHE_LIMIT && !candidateCache.has(key)) {
    candidateCache.clear();
  }
  candidateCache.set(key, { candidates, watched, links, settled });
  return candidates;
}

function addFolded(set: Set<string>, dir: string, file: string): void {
  set.add(path.join(dir, file).toLowerCase());
}

interface Walk {
  // False when the walk hit something it can't promise to notice changing.
  complete: boolean;
  // Where the dir resolved to, or null when it doesn't exist (yet).
  real: string | null;
}

interface WalkState {
  // Every dir whose entries a resolution read. Only dirs go in here.
  watched: Map<string, DirSignature>;
  links: Map<string, DirSignature>;
  // readlink results, so links shared by several credential dirs (macOS's
  // /var, say) are read once per build.
  targets: Map<string, string>;
}

// At least what any of our kernels allows in one lookup (Linux 40, macOS 32).
// A chain realpath gives up on but the walk finishes just disagrees with it,
// which leaves the snapshot untrusted.
const MAX_LINK_HOPS = 40;

/**
 * Resolve `dir` the way realpath does -- one component at a time with lstat,
 * splicing a symlink's target in ahead of whatever is left -- and sign every
 * directory whose entries that depended on: every dir walked through, which
 * includes the one holding each link and every dir the link's target passes
 * through. Each link is signed as well, since a Windows junction can be
 * re-pointed in place without touching the dir it sits in.
 *
 * A missing component is fine wherever it turns up -- in the path as written
 * or in a dangling link's target: the walk stops in the dir it would appear
 * in, that dir is already signed, and creating the entry rewrites it.
 * Anything else that stops the walk (an unreadable dir or link, a file where
 * a dir should be, too many hops) means the dirs a later resolution
 * would depend on aren't known, so the walk reports itself incomplete and the
 * snapshot is rebuilt on every call.
 *
 * So does a link target containing `..`. The kernel applies it to the dir the
 * preceding link really points into; fs.realpathSync drops it textually, so
 * the two land in different places and depend on different dirs. Neither
 * answer can be watched for both, so both realpaths are just redone each call.
 */
function watchResolution(dir: string, state: WalkState): Walk {
  const incomplete = { complete: false, real: null };
  const abs = path.resolve(dir);
  let cur = path.parse(abs).root;
  if (!state.watched.has(cur)) state.watched.set(cur, dirSignature(cur));
  // A stack: the next component is at the end.
  const pending = components(abs.slice(cur.length)).reverse();
  let hops = 0;
  while (pending.length > 0) {
    const next = path.join(cur, pending.pop()!);
    if (state.watched.has(next)) {
      cur = next;
      continue;
    }
    let target = state.targets.get(next);
    if (target === undefined) {
      let st: fs.Stats;
      try {
        st = fs.lstatSync(next);
      } catch (err) {
        return { complete: (err as NodeJS.ErrnoException).code === "ENOENT", real: null };
      }
      if (!st.isSymbolicLink()) {
        if (!st.isDirectory()) return incomplete;
        state.watched.set(next, signatureOf(st));
        cur = next;
        continue;
      }
      state.links.set(next, signatureOf(st));
      try {
        target = fs.readlinkSync(next);
      } catch {
        return incomplete;
      }
      state.targets.set(next, target);
    }
    if (++hops > MAX_LINK_HOPS) return incomplete;
    // Split on both separators: on POSIX a backslash is just a name
    // character, and calling it one only errs toward incomplete.
    if (target.split(/[\\/]/).includes("..")) return incomplete;
    const resolved = path.resolve(cur, target);
    cur = path.parse(resolved).root;
    if (!state.watched.has(cur)) state.watched.set(cur, dirSignature(cur));
    const parts = components(resolved.slice(cur.length));
    for (let i = parts.length - 1; i >= 0; i--) pending.push(parts[i]);
  }
  return { complete: true, real: cur };
}

function components(rel: string): string[] {
  return rel.split(path.sep).filter(Boolean);
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function dirSignature(dir: string): DirSignature {
  try {
    return signatureOf(fs.lstatSync(dir));
  } catch {
    return { key: "absent", changedAt: -Infinity };
  }
}

function signatureOf(st: fs.Stats): DirSignature {
  return {
    key: `${st.mtimeMs}:${st.ctimeMs}:${st.ino}`,
    // max, so a future mtime set by hand keeps the snapshot untrusted too.
    changedAt: Math.max(st.mtimeMs, st.ctimeMs),
  };
}

function signaturesMatch(watched: Map<string, DirSignature>): boolean {
  for (const [dir, sig] of watched) if (dirSignature(dir).key !== sig.key) return false;
  return true;
}

// A dir resolved both ways: fs.realpathSync is what the exec-guard's jail
// hands us, and the native one (what fs.promises.realpath gives the web files
// surface) can differ from it -- a `..` in a link target is the known case.
interface ResolvedDir {
  js: string | null;
  native: string | null;
}

// A path both as written and as resolved, since callers hand us realpaths. Only
// a file that is itself a symlink needs its own realpath; anything else
// resolves through its parent, which is resolved once per directory and shared
// through `resolvedParents`. That also covers a file that doesn't exist yet.
function withRealpath(
  p: string,
  resolvedParents: Map<string, ResolvedDir>,
  isLink: boolean,
  walks?: Map<string, Walk>,
): string[] {
  const out = [p];
  if (isLink) {
    const own = resolveBothWays(p);
    if (own.js !== null || own.native !== null) {
      for (const r of [own.js, own.native]) if (r !== null) out.push(r);
      return out;
    }
    /* dangling -- the parent-resolved spelling is still worth having */
  }
  const dir = path.dirname(p);
  let realDir = resolvedParents.get(dir);
  if (!realDir) {
    realDir = resolveBothWays(dir, walks?.get(dir));
    resolvedParents.set(dir, realDir);
  }
  for (const r of [realDir.js, realDir.native]) {
    if (r !== null) out.push(path.join(r, path.basename(p)));
  }
  return out;
}

/**
 * Both realpaths of `p`. A completed walk that agrees with fs.realpathSync has
 * just done what the kernel does -- it only completes when no link target has
 * a `..` in it, the one place the two part ways -- so off Windows the native
 * call is skipped then. On Windows the native one can still differ (an 8.3
 * short name comes back expanded, a subst or mapped drive as its target), and
 * callers that resolved natively hand us that spelling, so it always runs there.
 */
function resolveBothWays(p: string, walk?: Walk): ResolvedDir {
  const attempt = (resolve: (p: string) => string): string | null => {
    try {
      return resolve(p);
    } catch {
      /* nothing on disk yet -- the lexical path is all there is */
      return null;
    }
  };
  const js = attempt(fs.realpathSync);
  if (process.platform !== "win32" && walk?.complete && walk.real === js) {
    return { js, native: js };
  }
  return { js, native: attempt(fs.realpathSync.native) };
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
