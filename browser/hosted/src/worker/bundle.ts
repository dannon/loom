/**
 * Bundles a worker entry into one ESM file a worker_thread can load. vitest's transform and vi.mock
 * do not reach inside a worker, so the worker gets what the browser worker's bundler gives it
 * instead: TypeScript compiled, galaxy-ops' browser entry, the two Node-only packages Orbit imports
 * but never calls in this profile replaced by inert stand-ins, and the vendored skills inlined so the
 * worker never reads them from disk.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type BuildOptions, type Plugin } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..", "..", "..");
const LOOM = join(REPO, "extensions", "loom");
const SHARED = join(REPO, "shared");
const VENDOR = join(LOOM, "vendor", "skills");

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
export { createMemoryOutputStore, setGalaxyOutputStore } from "${LOOM}/galaxy-output-store.ts";
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

/** The vendored skills tree as module data, read once at bundle time. */
function vendorSkills(): string {
  const catalog: unknown = JSON.parse(readFileSync(join(VENDOR, "_catalog.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(VENDOR, "_manifest.json"), "utf8")) as {
    files: Array<{ target: string }>;
  };
  const files = Object.fromEntries(manifest.files.map((f) => [f.target, readFileSync(join(VENDOR, f.target), "utf8")]));
  return [
    `export const catalog = ${JSON.stringify(catalog)};`,
    `export const manifest = ${JSON.stringify(manifest)};`,
    `export const files = ${JSON.stringify(files)};`,
  ].join("\n");
}

const seams: Plugin = {
  name: "orbit-worker",
  setup(b) {
    b.onResolve({ filter: /^orbit-brain$/ }, () => ({ path: "orbit-brain", namespace: "orbit" }));
    b.onLoad({ filter: /.*/, namespace: "orbit" }, () => ({
      contents: ORBIT_BRAIN,
      loader: "ts",
      resolveDir: LOOM,
    }));
    b.onResolve({ filter: /^orbit-vendor-skills$/ }, () => ({ path: "orbit-vendor-skills", namespace: "vendor" }));
    b.onLoad({ filter: /.*/, namespace: "vendor" }, () => ({ contents: vendorSkills(), loader: "js" }));
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

/**
 * V8 keeps a script's source for its lifetime, at one byte per character only when the whole file
 * is ASCII (bench/RESULTS-boot.md). esbuild's ascii charset escapes strings but not regex literals or
 * legal comments; a \u escape means the same thing in a string, template, regex or identifier.
 */
export const asciiOnly = (source: string) =>
  source.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** The production bundle: minified and all ASCII, which together keep ~40 MB off each worker. */
export async function bundleWorkerForProduction(entry: string, outfile: string): Promise<string> {
  const result = await build({ ...options(entry, outfile), minify: true, legalComments: "none", write: false });
  const text = asciiOnly(result.outputFiles![0]!.text);
  mkdirSync(dirname(outfile), { recursive: true });
  const stray = text.search(/[^\x00-\x7f]/);
  if (stray >= 0) throw new Error(`The worker bundle has a non-ASCII byte at ${stray}`);
  writeFileSync(outfile, text);
  return outfile;
}

export async function bundleWorker(entry: string, outfile: string): Promise<string> {
  await build(options(entry, outfile));
  return outfile;
}

function options(entry: string, outfile: string) {
  return {
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node" as const,
    format: "esm" as const,
    target: "node22",
    logLevel: "error" as const,
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
  } satisfies BuildOptions;
}
