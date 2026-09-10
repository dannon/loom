import { describe, expect, it } from "vitest";
import {
  emptyProviderState,
  snapshotProviderState,
  type ProviderState,
} from "../app/src/renderer/provider-state.js";
import { planModelDiscovery } from "../app/src/renderer/model-discovery-gate.js";

const ENDPOINT = "https://openrouter.ai/api/v1";

/** A custom endpoint that has been saved and already answered a probe once. */
function discoveredProvider(): ProviderState {
  return {
    hadKey: true,
    typedKey: "",
    model: "openai/gpt-4o",
    baseUrl: ENDPOINT,
    savedBaseUrl: ENDPOINT,
    discoveredModels: ["openai/gpt-4o", "anthropic/claude-opus-5"],
  };
}

/** The form as it reads when the user has touched nothing. */
function fieldsOf(state: ProviderState) {
  return { typedKey: state.typedKey, model: state.model, baseUrl: state.baseUrl };
}

describe("snapshotProviderState", () => {
  it("takes the editable fields from the form", () => {
    const next = snapshotProviderState(discoveredProvider(), {
      typedKey: "sk-newly-typed",
      model: "anthropic/claude-opus-5",
      baseUrl: "  https://elsewhere.example/v1  ",
    });

    expect(next.typedKey).toBe("sk-newly-typed");
    expect(next.model).toBe("anthropic/claude-opus-5");
    expect(next.baseUrl).toBe("https://elsewhere.example/v1");
  });

  // These three describe config and the endpoint's answer, not the form. The
  // form has no input for any of them, so reading them off it yields nothing.
  it("carries the non-form state forward instead of rebuilding it", () => {
    const next = snapshotProviderState(discoveredProvider(), {
      typedKey: "",
      model: "openai/gpt-4o",
      baseUrl: "https://elsewhere.example/v1",
    });

    expect(next.hadKey).toBe(true);
    expect(next.savedBaseUrl).toBe(ENDPOINT);
    expect(next.discoveredModels).toEqual(["openai/gpt-4o", "anthropic/claude-opus-5"]);
  });

  it("starts a never-visited provider blank", () => {
    expect(snapshotProviderState(undefined, { typedKey: "", model: "", baseUrl: "" })).toEqual(
      emptyProviderState(),
    );
  });
});

/**
 * The gate's own tests hand it a `savedBaseUrl` directly, so they cannot tell
 * whether that value actually survives the trip through a provider switch.
 * This composes the two: switch away, switch back, then ask the gate. If a
 * refactor ever rebuilds the snapshot from the form fields alone, the gate
 * stops probing and the picker goes empty -- issue #432, and every assertion
 * in model-discovery-gate.test.ts still passes. This is the one that fails.
 */
describe("a provider switch preserves what the discovery gate reads", () => {
  it("still probes after switching away and back", () => {
    const before = discoveredProvider();
    // Opening the pane once already fetched the list, so the gate would skip a
    // second probe. Discovery is per Preferences session, so on the way back in
    // the list is gone and the probe has to happen again.
    expect(
      planModelDiscovery({
        manual: false,
        savedBaseUrl: before.savedBaseUrl,
        typedBaseUrl: before.baseUrl,
        typedKey: before.typedKey,
        hadKey: before.hadKey,
        alreadyDiscovered: true,
      }),
    ).toEqual({ action: "skip" });

    const stashed = snapshotProviderState(before, fieldsOf(before));
    const restored = snapshotProviderState(stashed, fieldsOf(stashed));

    expect(
      planModelDiscovery({
        manual: false,
        savedBaseUrl: restored.savedBaseUrl,
        typedBaseUrl: restored.baseUrl,
        typedKey: restored.typedKey,
        hadKey: restored.hadKey,
        alreadyDiscovered: false,
      }),
    ).toEqual({ action: "probe" });
  });

  it("does not turn a saved endpoint into an unsaved-edits message", () => {
    const stashed = snapshotProviderState(discoveredProvider(), fieldsOf(discoveredProvider()));

    // Pressing "Fetch models" on an untouched form must reach the endpoint. If
    // savedBaseUrl were dropped the gate would instead tell the user to save a
    // base URL that is already saved.
    expect(
      planModelDiscovery({
        manual: true,
        savedBaseUrl: stashed.savedBaseUrl,
        typedBaseUrl: stashed.baseUrl,
        typedKey: "",
        hadKey: stashed.hadKey,
        alreadyDiscovered: false,
      }),
    ).toEqual({ action: "probe" });
  });
});
