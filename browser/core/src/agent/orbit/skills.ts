/**
 * Orbit's vendored skills tree for the worker: the catalog and manifest inline, the bodies as
 * files beside the bundle, fetched when skills_fetch reads one. Inlining the bodies would put
 * 2.3 MB of text in the worker bundle that most sessions never read.
 */
import catalog from "../../../../../extensions/loom/vendor/skills/_catalog.json";
import manifest from "../../../../../extensions/loom/vendor/skills/_manifest.json";
import type { VendorSkillsSource } from "../../../../../extensions/loom/vendor-skills";

const ROOT = "../../../../../extensions/loom/vendor/skills/";

const BODIES = import.meta.glob("../../../../../extensions/loom/vendor/skills/**/*", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

const TARGETS = new Set(
  (manifest as { files: Array<{ target: string }> }).files.map((f) => f.target),
);

/** A source that answers only manifest targets, as the file tree under Node does. */
export function vendorSkills(): VendorSkillsSource {
  return {
    catalog,
    manifest,
    async read(target) {
      if (!TARGETS.has(target)) return null;
      const url = BODIES[`${ROOT}${target}`];
      if (!url) return null;
      const response = await fetch(url);
      return response.ok ? response.text() : null;
    },
  };
}
