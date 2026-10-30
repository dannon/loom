import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  GALAXY_OUTPUT_MARKER,
  inspectOutput,
  spillPreview,
} from "../extensions/orbit/galaxy-output";
import { utf8ByteLength } from "../shared/truncate-middle.js";

const ROOT = join(__dirname, "..");

function userTools(count = 57) {
  return {
    data: Array.from({ length: count }, (_, i) => ({
      id: `encoded-tool-${i}`,
      uuid: `user-tool-uuid-${i}`,
      tool_id: "example_tool",
      tool_format: "GalaxyUserTool",
      active: i !== 3,
      hidden: i === 3,
      representation: {
        class: "GalaxyUserTool",
        name: i === count - 1 ? "ChronAeon validator" : `Example tool ${i}`,
        version: `1.${i}.0`,
        description: "A useful tool",
        container: "example.invalid/python:3.11",
        shell_command: "private command body; ".repeat(250),
        inputs: [{ name: "alignment", type: "data" }],
      },
    })),
    success: true,
    message: "Retrieved user-defined tools",
    count,
    pagination: null as unknown,
  };
}

function unicodeCatalog() {
  const payload = userTools(31);
  for (const item of payload.data) {
    item.representation.description = "🧬".repeat(3000);
    item.representation.name = "🧬".repeat(3000);
  }
  return payload;
}

function toolPanel() {
  return {
    success: true,
    data: Array.from({ length: 87 }, (_, section) => ({
      name: `Section ${section}`,
      elems: Array.from({ length: 80 }, (_, i) => ({
        id: `tool-${section}-${i}`,
        name: section === 86 && i === 79 ? "TISSUE" : "Other tool",
        description: "x".repeat(400),
      })),
    })),
  };
}

describe("inspectOutput extraction", () => {
  it("bounds catalog pages by UTF-8 bytes as before", () => {
    const page = inspectOutput(JSON.stringify(unicodeCatalog()), { outputId: "x", limit: 20 });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(14_000);
    expect((page.items as unknown[]).length).toBeGreaterThan(0);
  });
});

const ID = "01JAAAAAAAAAAAAAAAAAAAAAAA";

describe("spillPreview", () => {
  it("shows a catalog headline and catalog paging advice for user-defined tools", () => {
    const envelope = JSON.stringify(userTools());
    const text = spillPreview(envelope, ID, false);
    const [headline, overview] = text.split("\n");
    expect(headline).toBe(
      "User-defined tools: showing 20 of 57 tools in this response. This response holds 57; read the rest first with galaxy_read_output offset=20. Galaxy did not report a total, so other pages may exist. Full definitions are available on demand.",
    );
    expect(JSON.parse(overview)).toEqual(inspectOutput(envelope, { outputId: ID, limit: 20 }));
    expect(text).toContain("page this catalog by passing its nextOffset as offset");
    expect(text).not.toContain("private command body");
  });

  function catalogHeadline(payload: ReturnType<typeof userTools>) {
    return spillPreview(JSON.stringify(payload), ID, false).split("\n")[0];
  }

  it("headlines Galaxy's real total and next offset when a catalog page was cut short", () => {
    // Galaxy's output budget trimmed a limit=25 page to 5, so next_offset is 5, not 25.
    const payload = userTools(5);
    payload.count = 5;
    payload.pagination = {
      total_items: 234,
      returned_items: 5,
      limit: 25,
      offset: 0,
      has_next: true,
      has_previous: false,
      next_offset: 5,
      previous_offset: null,
      helper_text: "Page truncated to fit the output budget; use offset=5 for the next page.",
    };
    const headline = catalogHeadline(payload);
    expect(headline).toContain("234");
    expect(headline).toContain("offset 0");
    expect(headline).toContain("offset=5");
    expect(headline).toMatch(/more pages exist/i);
    expect(headline).not.toContain("offset=25");
    expect(headline).not.toMatch(/\b5 of 5\b/);
    expect(headline).not.toMatch(/\bMCP\b|mcp_read_output/);
  });

  it("says a catalog page is the last one only when Galaxy says so", () => {
    const payload = userTools(4);
    payload.pagination = {
      total_items: 234,
      offset: 230,
      has_next: false,
      next_offset: null,
      previous_offset: 205,
    };
    const headline = catalogHeadline(payload);
    expect(headline).toContain("234");
    expect(headline).toContain("offset 230");
    expect(headline).toMatch(/last page/i);
    expect(headline).not.toMatch(/more pages exist/i);
  });

  it("names galaxy_read_output when this response holds more than one preview page", () => {
    const payload = userTools(25);
    payload.pagination = { total_items: 234, offset: 0, has_next: true, next_offset: 25 };
    const headline = catalogHeadline(payload);
    expect(headline).toMatch(/^User-defined tools: showing 20 of 234 \(Galaxy offset 0\)\./);
    // Re-calling Galaxy before reading tools 20-24 of this response would skip them.
    expect(headline).toContain("read the rest first with galaxy_read_output offset=20.");
    expect(headline).toContain("after that, re-call the Galaxy tool with offset=25.");
    expect(headline).not.toContain("mcp_read_output");
  });

  it("exposes the normalized Galaxy page in the overview the model pages with", () => {
    const payload = userTools(5);
    payload.pagination = { total_items: 234, offset: 10, next_offset: 10 };
    const page = inspectOutput(JSON.stringify(payload), { outputId: ID });
    expect(page.galaxyPage).toEqual({
      totalItems: 234,
      offset: 10,
      hasNext: true,
      nextOffset: null,
    });
    const headline = catalogHeadline(payload);
    expect(headline).toMatch(/more pages exist/i);
    expect(headline).toContain("a later offset");
    expect(headline).not.toContain("offset=10");
  });

  it("trusts neither side of contradictory pagination", () => {
    const payload = userTools(5);
    payload.pagination = { total_items: 234, offset: 0, has_next: false, next_offset: 5 };
    expect(catalogHeadline(payload)).toMatch(/did not say whether more pages exist/i);
    expect(catalogHeadline(payload)).not.toMatch(/last page/i);
    payload.pagination = { total_items: 234, offset: 0, has_next: true, next_offset: 250 };
    const headline = catalogHeadline(payload);
    expect(headline).toMatch(/more pages exist/i);
    expect(headline).not.toContain("offset=250");
  });

  it("does not imply a catalog is complete when Galaxy sent no pagination block", () => {
    const headline = catalogHeadline(userTools(5));
    expect(headline).toMatch(/^User-defined tools: showing 5 of 5 tools in this response/);
    expect(headline).toMatch(/did not report a total/i);
    expect(headline).not.toMatch(/last page/i);
    expect(inspectOutput(JSON.stringify(userTools(5)), { outputId: ID }).galaxyPage).toBeNull();
  });

  it("keeps the error headline for a failed catalog response", () => {
    const failed = userTools(2);
    failed.success = false;
    failed.message = "Access denied";
    const text = spillPreview(JSON.stringify(failed), ID, true);
    expect(text.split("\n")[0]).toBe(
      "Galaxy returned a large error response. Saved response preview follows.",
    );
    expect(text).toContain("Access denied");
    expect(text).not.toContain("User-defined tools: showing");
  });

  it("ends with the marker and the galaxy_read_output pointer", () => {
    const envelope = JSON.stringify({
      success: true,
      data: Array.from({ length: 500 }, (_, i) => ({ id: `d${i}`, name: "x".repeat(60) })),
    });
    const text = spillPreview(envelope, ID, false);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Large Galaxy response saved in memory. Showing a bounded preview.");
    expect(lines[2]).toBe(GALAXY_OUTPUT_MARKER);
    expect(GALAXY_OUTPUT_MARKER).toBe("[loom Galaxy output]");
    expect(lines[3]).toBe(
      `For more detail, use galaxy_read_output with outputId "${ID}". Select a JSON Pointer from the preview, or use query to find relevant records. A partial preview does not establish that omitted records are absent. Saved outputs live in memory for this session only. Inspect required fields before proceeding. Do not repeat the original operation just to recover output.`,
    );
    expect(lines).toHaveLength(4);
    expect(text).not.toMatch(/\bMCP\b/);
  });

  it("falls back to a head and tail cut when one entry exceeds the preview budget", () => {
    // Twelve long key names make even the bounded object preview larger than a page.
    const entry = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`${i}${"k".repeat(2000)}`, i]),
    );
    const envelope = JSON.stringify({ data: [entry] });
    expect(() => inspectOutput(envelope, { outputId: ID, pointer: "/data", limit: 20 })).toThrow(
      "preview budget",
    );
    const big = JSON.stringify([entry, entry, entry]);
    expect(() => inspectOutput(big, { outputId: ID, limit: 20 })).toThrow("preview budget");
    const text = spillPreview(big, ID, false);
    expect(text).toContain("chars truncated…");
    expect(text).toContain(GALAXY_OUTPUT_MARKER);
    expect(text).toContain(`outputId "${ID}"`);
    expect(utf8ByteLength(text)).toBeLessThan(20 * 1024);
  });

  it("stays under the 20 KiB spill threshold for a large ordinary response", () => {
    const envelope = JSON.stringify(toolPanel());
    expect(utf8ByteLength(spillPreview(envelope, ID, false))).toBeLessThan(20 * 1024);
  });
});

// Modules that run in the browser worker as well as Orbit.
const HOT_PATH = [
  "shared/truncate-middle.js",
  "shared/markdown-sections.js",
  "shared/malformed-object-ids.js",
  "extensions/orbit/galaxy-output.ts",
  "extensions/orbit/galaxy-output-store.ts",
  "extensions/orbit/galaxy-ops-tools.ts",
  "extensions/orbit/galaxy-tool-wrap.ts",
  "extensions/orbit/galaxy-failure.ts",
  "extensions/orbit/galaxy-op-policy.ts",
  "extensions/orbit/galaxy-page-ops.ts",
  "extensions/orbit/galaxy-job-ops.ts",
];

// The transport seam, reached through galaxyOpsContext. Its process.env read is the fallback
// when no transport supplies credentials, and the browser installs one; nothing else may read env.
const ENV_FALLBACK = new Set(["extensions/orbit/galaxy-api.ts"]);
// Posix spelling, so the set and the reach list match on Windows too.
const rel = (file: string) => relative(ROOT, file).split(sep).join("/");

const FORBIDDEN_TOKEN = /node:|\bBuffer\b|\btmpdir\b|process\.env|\bcrypto\b|\brequire\s*\(/;
const NODE_SPECIFIER =
  /^(?:node:|fs$|fs\/|path$|os$|crypto$|tus-js-client$|@earendil-works\/pi-coding-agent)/;

// Type-only imports are erased before anything runs, so they reach nothing.
function withoutTypeImports(text: string): string {
  return text
    .replace(/\b(?:import|export)\s+type\s[\s\S]*?from\s*["'][^"']+["']\s*;?/g, "")
    .replace(
      /\bimport\s*\{\s*(?:type\s+\w+(?:\s+as\s+\w+)?\s*,?\s*)+\}\s*from\s*["'][^"']+["']\s*;?/g,
      "",
    );
}

function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const m of withoutTypeImports(source).matchAll(
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g,
  ))
    found.push(m[1]);
  return found;
}

function resolveRelative(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec);
  return [base, `${base}.ts`, `${base}.js`, join(base, "index.ts")].find((p) =>
    statSync(p, { throwIfNoEntry: false })?.isFile(),
  );
}

describe("hot-path modules stay Node-free", () => {
  it.each(HOT_PATH)("%s contains no Node-only token", (file) => {
    const source = readFileSync(join(ROOT, file), "utf8");
    expect(source).not.toMatch(FORBIDDEN_TOKEN);
    // A value import of pi counts as a Node edge in the browser conformance scan.
    expect(source).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+["']@earendil-works\//m);
  });

  it("nothing a hot-path module imports, transitively, reaches a Node module", () => {
    const seen = new Set<string>();
    const queue = HOT_PATH.map((f) => join(ROOT, f));
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      const node = ENV_FALLBACK.has(rel(file))
        ? /\bBuffer\b|\btmpdir\b/
        : /\bBuffer\b|\btmpdir\b|process\.env/;
      expect(source, rel(file)).not.toMatch(node);
      for (const spec of specifiers(source)) {
        expect(spec, `${rel(file)} imports ${spec}`).not.toMatch(NODE_SPECIFIER);
        if (spec.startsWith(".")) {
          const target = resolveRelative(file, spec);
          expect(target, `${rel(file)} -> ${spec}`).toBeDefined();
          queue.push(target!);
        }
      }
    }
    // Proves the walk follows imports; the ring's ids come through ulid.ts.
    const reached = [...seen].map(rel);
    expect(reached).toContain("shared/random.js");
    expect(reached).toContain("extensions/orbit/galaxy-api.ts");
    expect(reached).toContain("shared/page-content-hash.js");
    // The page policy's record lock comes through the seam, never the fs-backed store.
    expect(reached).toContain("extensions/orbit/record-store-seam.ts");
    expect(reached).not.toContain("extensions/orbit/record-store-file.ts");
    // Only the source's types are imported; the registrar and the profile it reads stay out.
    expect(reached).not.toContain("extensions/orbit/galaxy-tool-source.ts");
  });
});
