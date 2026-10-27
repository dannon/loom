import { describe, expect, it } from "vitest";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { FALLBACK_MODELS_BY_PROVIDER } from "../app/src/renderer/model-fallback.js";
import { isDeprecatedModelId } from "../app/src/main/model-catalog.js";

const NOT_FROM_PI = new Set(["openai-compatible"]);

// The fallback only shows when the registry IPC fails, which is exactly when
// nobody notices it has drifted -- openai-codex listed three ids pi never
// shipped for that provider (#609).
describe("fallback model catalog", () => {
  const providers = new Set<string>(getProviders());

  for (const [provider, models] of Object.entries(FALLBACK_MODELS_BY_PROVIDER)) {
    if (NOT_FROM_PI.has(provider)) continue;
    it(`${provider}: every fallback id is a current pi registry model`, () => {
      expect(providers.has(provider)).toBe(true);
      const shipped = new Set(
        getModels(provider as Parameters<typeof getModels>[0])
          .map((m) => m.id)
          .filter((id) => !isDeprecatedModelId(provider, id)),
      );
      expect(models.map((m) => m.id).filter((id) => !shipped.has(id))).toEqual([]);
    });
  }
});
