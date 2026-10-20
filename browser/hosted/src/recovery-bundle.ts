/**
 * Bundles recovery-worker.ts into one ESM file a worker_thread can load. vitest's transform and
 * vi.mock do not reach inside a worker, so the worker gets what the browser worker's bundler
 * gives it instead: TypeScript compiled, galaxy-ops' browser entry, and the two Node-only packages
 * Orbit imports but never calls in this profile replaced by inert stand-ins.
 */
import { build, type Plugin } from "esbuild";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..", "..");
const LOOM = join(REPO, "extensions", "loom");
const SHARED = join(REPO, "shared");

/** The same seams pi-host.orbit.test.ts imports one by one, as a single module. */
const ORBIT_BRAIN = `
export { default as loom } from "${LOOM}/index.ts";
export { setCapabilityProfile } from "${SHARED}/capability-profile.js";
export { setConfigSource } from "${SHARED}/config-source.js";
export { setInstructionSource } from "${LOOM}/user-instructions.ts";
export { setVendorSkillsSource } from "${LOOM}/vendor-skills.ts";
export { setGalaxyTransport } from "${LOOM}/galaxy-api.ts";
export { setRecordStore } from "${LOOM}/record-store.ts";
export { createPageRecordStore } from "${LOOM}/record-store-page.ts";
export { setGalaxyToolSource } from "${LOOM}/galaxy-tool-source.ts";
export { createGalaxyOpsToolSource } from "${LOOM}/galaxy-ops-tools.ts";
`;

// Anything Orbit reaches on these stand-ins answers with more of itself; nothing in this profile
// calls them, and a call would show up as a missing effect rather than a native-module crash.
const INERT = `
const inert = () => new Proxy(function () {}, {
  get: (_t, p) => (p === "then" || typeof p === "symbol" ? undefined : inert()),
  apply: () => inert(),
  construct: () => inert(),
});
const stub = inert();
export default stub;
export const watch = stub;
`;

const seams: Plugin = {
  name: "orbit-recovery",
  setup(b) {
    b.onResolve({ filter: /^orbit-brain$/ }, () => ({ path: "orbit-brain", namespace: "orbit" }));
    b.onLoad({ filter: /.*/, namespace: "orbit" }, () => ({
      contents: ORBIT_BRAIN,
      loader: "ts",
      resolveDir: LOOM,
    }));
    b.onResolve({ filter: /^(chokidar|better-sqlite3)$/ }, (args) => ({
      path: args.path,
      namespace: "inert",
    }));
    b.onLoad({ filter: /.*/, namespace: "inert" }, () => ({ contents: INERT, loader: "js" }));
    // From extensions/loom the bare specifier finds the root package's Node entry; the worker
    // shell's bundler picks the browser entry, which pi-host.orbit.test.ts mocks in the same way.
    b.onResolve({ filter: /^@galaxyproject\/galaxy-ops$/ }, (args) =>
      args.importer.startsWith(LOOM) || args.importer.startsWith(SHARED)
        ? { path: join(REPO, "node_modules/@galaxyproject/galaxy-ops/dist/index.browser.js") }
        : undefined,
    );
  },
};

export async function bundleRecoveryWorker(outfile: string): Promise<string> {
  await build({
    entryPoints: [join(HERE, "recovery-worker.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "error",
    plugins: [seams],
    // Bundled, every module shares the worker entry's import.meta, so lessons/validate.mjs would
    // take itself for the CLI and exit the thread.
    define: { "import.meta.main": "false" },
    // CommonJS dependencies inside an ESM bundle still call require.
    banner: {
      js: [
        'import { createRequire as __rcRequire } from "node:module";',
        "const require = __rcRequire(import.meta.url);",
      ].join("\n"),
    },
  });
  return outfile;
}
