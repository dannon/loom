// Resolve the on-disk directory of a Pi extension package (pi-mcp-adapter,
// pi-web-access) so bin/loom.js can hand the path to Pi as an extension.
//
// Two package shapes are in the wild and neither resolves the other's way:
//
//   * No "exports" map (pi-mcp-adapter <=2.11.0, pi-web-access today). These
//     also declare no "main", so the bare specifier has nothing to resolve
//     against -- only the deep "<name>/index.ts" subpath works.
//   * An "exports" map (pi-mcp-adapter >=2.12.0). Exports are a closed list, so
//     the deep subpath is refused with ERR_PACKAGE_PATH_NOT_EXPORTED -- only the
//     bare specifier works, and it points at index.ts anyway.
//
// Loom depends on a range that spans both shapes, so a fresh install resolves to
// whichever the registry serves today. Hardcoding either specifier breaks the
// other half. pi-mcp-adapter 2.12.0 added its exports map on 2026-07-24 and that
// silently broke `npm install -g @galaxyproject/loom` -- the CLI died on startup
// before printing anything. Try both and take whichever answers.

import { dirname } from "node:path";

/**
 * @param {string} name package name, e.g. "pi-mcp-adapter"
 * @param {(specifier: string) => string} resolveSpecifier normally a
 *   `createRequire(...)`-derived `require.resolve`; injected so this is testable
 *   without installing several versions of the real package.
 * @returns {string} directory containing the extension's entry point
 */
export function resolvePiExtensionDir(name, resolveSpecifier) {
  const failures = [];
  // Bare first: it honors whatever entry point the package declares. The deep
  // subpath is the compatibility fallback for packages that declare none.
  for (const specifier of [name, `${name}/index.ts`]) {
    try {
      return dirname(resolveSpecifier(specifier));
    } catch (err) {
      failures.push(`  ${specifier} -- ${err && (err.code || err.message)}`);
    }
  }
  throw new Error(
    `loom: could not resolve the "${name}" extension. Tried:\n${failures.join("\n")}\n` +
      `This usually means the package is missing or was published with an entry ` +
      `point Loom does not know about. Reinstalling Loom normally fixes it.`,
  );
}
