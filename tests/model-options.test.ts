import { describe, expect, it } from "vitest";
import {
  buildDiscoveredModelOptions,
  pickOfferedProvider,
  unavailableProviders,
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
