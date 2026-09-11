import { describe, it, expect } from "vitest";
import { resolvePiExtensionDir } from "../bin/pi-extension-path.js";

/** Stand in for Node's resolver: succeed only for `allowed`, otherwise throw
 * with the code Node actually uses for that failure. */
function fakeResolver(allowed: Record<string, string>) {
  return (specifier: string) => {
    if (specifier in allowed) return allowed[specifier];
    const err: NodeJS.ErrnoException = new Error(`cannot resolve ${specifier}`);
    // A package with an "exports" map refuses unlisted subpaths; one without
    // any entry point simply isn't found.
    err.code = specifier.includes("/") ? "ERR_PACKAGE_PATH_NOT_EXPORTED" : "MODULE_NOT_FOUND";
    throw err;
  };
}

describe("resolvePiExtensionDir", () => {
  it("resolves a package that only answers the bare specifier (exports map, pi-mcp-adapter >=2.12.0)", () => {
    const dir = resolvePiExtensionDir(
      "pi-mcp-adapter",
      fakeResolver({ "pi-mcp-adapter": "/app/node_modules/pi-mcp-adapter/index.ts" }),
    );
    expect(dir).toBe("/app/node_modules/pi-mcp-adapter");
  });

  it("falls back to the deep subpath when there is no entry point to resolve bare (pi-mcp-adapter <=2.11.0, pi-web-access)", () => {
    const dir = resolvePiExtensionDir(
      "pi-web-access",
      fakeResolver({ "pi-web-access/index.ts": "/app/node_modules/pi-web-access/index.ts" }),
    );
    expect(dir).toBe("/app/node_modules/pi-web-access");
  });

  it("prefers the bare specifier when both resolve", () => {
    const probed: string[] = [];
    const resolver = (specifier: string) => {
      probed.push(specifier);
      return `/app/node_modules/${specifier.replace(/\/index\.ts$/, "")}/index.ts`;
    };
    const dir = resolvePiExtensionDir("pi-mcp-adapter", resolver);
    expect(dir).toBe("/app/node_modules/pi-mcp-adapter");
    // Bare answered, so the subpath was never tried.
    expect(probed).toEqual(["pi-mcp-adapter"]);
  });

  it("throws an actionable error naming both attempts when neither resolves", () => {
    expect(() => resolvePiExtensionDir("pi-mcp-adapter", fakeResolver({}))).toThrow(
      /could not resolve the "pi-mcp-adapter" extension/,
    );
    // The message has to carry both failures -- the whole bug was that one
    // specifier silently stopped working and the stack pointed nowhere useful.
    try {
      resolvePiExtensionDir("pi-mcp-adapter", fakeResolver({}));
      expect.unreachable("should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("pi-mcp-adapter -- MODULE_NOT_FOUND");
      expect(message).toContain("pi-mcp-adapter/index.ts -- ERR_PACKAGE_PATH_NOT_EXPORTED");
    }
  });
});
