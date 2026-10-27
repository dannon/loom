import { describe, expect, it } from "vitest";
import {
  buildDiscoveredModelOptions,
  pickOfferedProvider,
  unavailableProviders,
  discoveredModelsStatus,
  reconcileTypedModel,
} from "../app/src/renderer/model-options.js";

describe("buildDiscoveredModelOptions", () => {
  it("lists every discovered id", () => {
    expect(buildDiscoveredModelOptions(["a/one", "b/two"])).toEqual([
      { id: "a/one", label: "a/one", selected: false },
      { id: "b/two", label: "b/two", selected: false },
    ]);
  });

  it("marks the saved model selected when the endpoint still lists it", () => {
    const opts = buildDiscoveredModelOptions(["a/one", "b/two"], "b/two");
    expect(opts.map((o) => o.id)).toEqual(["a/one", "b/two"]);
    expect(opts.find((o) => o.selected)?.id).toBe("b/two");
  });

  // Losing the saved model here would silently switch the configured model to
  // whichever id the endpoint happens to list first.
  it("keeps a saved model the endpoint no longer lists", () => {
    const opts = buildDiscoveredModelOptions(["a/one"], "gone/model");
    expect(opts).toEqual([
      { id: "a/one", label: "a/one", selected: false },
      { id: "gone/model", label: "gone/model (custom)", selected: true },
    ]);
  });

  it("returns just the saved model when nothing was discovered", () => {
    expect(buildDiscoveredModelOptions([], "saved/model")).toEqual([
      { id: "saved/model", label: "saved/model (custom)", selected: true },
    ]);
  });

  it("returns nothing when there is neither a discovery nor a saved model", () => {
    expect(buildDiscoveredModelOptions([])).toEqual([]);
  });

  it("dedupes and skips blank ids", () => {
    const opts = buildDiscoveredModelOptions(["a/one", "a/one", " ", ""], "a/one");
    expect(opts).toEqual([{ id: "a/one", label: "a/one", selected: true }]);
  });

  it("trims ids so a padded response still matches the saved model", () => {
    const opts = buildDiscoveredModelOptions([" a/one "], "a/one");
    expect(opts).toEqual([{ id: "a/one", label: "a/one", selected: true }]);
  });
});

describe("unavailableProviders (#598)", () => {
  it("flags picker entries pi doesn't ship, but never the kept ones", () => {
    expect(
      unavailableProviders(
        ["anthropic", "ollama", "openai-compatible"],
        ["anthropic", "openai"],
        ["openai-compatible"],
      ),
    ).toEqual(["ollama"]);
  });
});

describe("pickOfferedProvider (#598)", () => {
  it("keeps a saved provider the picker offers", () => {
    expect(pickOfferedProvider("openai", ["anthropic", "openai"], "anthropic")).toBe("openai");
    expect(pickOfferedProvider("OpenAI", ["anthropic", "openai"], "anthropic")).toBe("openai");
  });

  // Showing a blank picker and saving it would write the dead provider back.
  it("falls back when the saved provider is gone", () => {
    expect(pickOfferedProvider("ollama", ["anthropic", "openai"], "anthropic")).toBe("anthropic");
    expect(pickOfferedProvider(undefined, ["anthropic"], "anthropic")).toBe("anthropic");
    // Never a fallback the picker can't show either.
    expect(pickOfferedProvider("ollama", ["openai", "google"], "anthropic")).toBe("openai");
  });
});

// #601: the typed field is backed by a <datalist>, and Chromium only suggests
// entries matching what's already typed -- so a stale id from a previous
// endpoint hid the one model the new endpoint actually serves.
describe("reconcileTypedModel", () => {
  it("swaps a stale id for the endpoint's only model", () => {
    expect(reconcileTypedModel("old-endpoint-model", ["qwen3-30b"])).toBe("qwen3-30b");
  });

  it("fills an empty field with the first model", () => {
    expect(reconcileTypedModel("", ["a", "b"])).toBe("a");
    expect(reconcileTypedModel("  ", ["a", "b"])).toBe("a");
  });

  it("keeps an id the endpoint lists", () => {
    expect(reconcileTypedModel("b", ["a", "b"])).toBe("b");
    expect(reconcileTypedModel("qwen3-30b", ["qwen3-30b"])).toBe("qwen3-30b");
  });

  // Plenty of gateways list only part of what they serve, so with a real
  // choice on offer a typed id isn't provably wrong.
  it("keeps an unlisted id when the endpoint offers several", () => {
    expect(reconcileTypedModel("typed-by-hand", ["a", "b"])).toBe("typed-by-hand");
  });

  it("leaves the field alone when nothing was listed", () => {
    expect(reconcileTypedModel("x", [])).toBe("x");
    expect(reconcileTypedModel("", [])).toBe("");
  });
});

describe("discoveredModelsStatus", () => {
  it("counts what the endpoint listed", () => {
    expect(discoveredModelsStatus("a", ["a"])).toBe("✓ 1 model available");
    expect(discoveredModelsStatus("a", ["a", "b"])).toBe("✓ 2 models available");
  });

  it("says when the field holds an id that isn't on the list", () => {
    expect(discoveredModelsStatus("typed-by-hand", ["a", "b"])).toBe(
      '✓ 2 models available -- "typed-by-hand" isn\'t one of them; clear the field to see the list',
    );
  });
});
