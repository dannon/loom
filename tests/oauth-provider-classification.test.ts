import { describe, it, expect } from "vitest";
import {
  classifyProviderAuth,
  isOAuthOnly,
  SEED_OAUTH_ONLY_PROVIDERS,
  SEED_PROVIDER_AUTH_CAPS,
} from "../shared/provider-auth-caps.js";

/**
 * #429: Orbit read "this provider can sign in" as "this provider has no API
 * key", which hid Anthropic's key field, masked hasApiKey, and stopped the
 * brain's key injection -- so the brain judged Anthropic unusable and flipped
 * llm.active to a signed-in Codex account behind the user's back.
 *
 * The shapes below mirror pi-ai 0.84.1's registry entries. This imports the
 * shared module rather than app/src/main/oauth-handler.ts on purpose: that one
 * pulls in Electron, which the root install (the tree `npm publish` runs the
 * tests against) does not have.
 */
describe("classifyProviderAuth", () => {
  it("treats a sign-in-only provider as OAuth-only", () => {
    const caps = classifyProviderAuth({
      id: "openai-codex",
      auth: { oauth: { login: () => {}, name: "OpenAI (ChatGPT Plus/Pro)" } },
    });
    expect(caps).toEqual({
      signInLabel: "",
      providerLabel: "OpenAI (ChatGPT Plus/Pro)",
      acceptsApiKey: false,
    });
  });

  it("keeps a dual-auth provider on the API-key path", () => {
    const caps = classifyProviderAuth({
      id: "anthropic",
      auth: {
        apiKey: { name: "Anthropic API key" },
        oauth: { login: () => {}, name: "Anthropic (Claude Pro/Max)" },
      },
    });
    // The regression was acceptsApiKey coming back false here.
    expect(caps).toEqual({
      signInLabel: "",
      providerLabel: "Anthropic (Claude Pro/Max)",
      acceptsApiKey: true,
    });
  });

  it("returns null for a provider with no sign-in flow", () => {
    expect(classifyProviderAuth({ id: "groq", auth: { apiKey: {} } })).toBeNull();
    expect(classifyProviderAuth({ id: "mistral" })).toBeNull();
  });

  it("ignores an oauth block that carries no login flow", () => {
    expect(classifyProviderAuth({ id: "half", auth: { oauth: { name: "Half" } } })).toBeNull();
  });

  it("keeps pi's button text and provider name apart", () => {
    // pi's loginLabel is already a whole button; folding it into the name field
    // rendered "Sign in with Sign in with SuperGrok or X Premium".
    expect(
      classifyProviderAuth({
        id: "xai",
        auth: {
          apiKey: {},
          oauth: {
            login: () => {},
            name: "xAI (Grok/X subscription)",
            loginLabel: "Sign in with SuperGrok or X Premium",
          },
        },
      }),
    ).toEqual({
      signInLabel: "Sign in with SuperGrok or X Premium",
      providerLabel: "xAI (Grok/X subscription)",
      acceptsApiKey: true,
    });
    expect(classifyProviderAuth({ id: "bare", auth: { oauth: { login: () => {} } } })).toEqual({
      signInLabel: "",
      providerLabel: "",
      acceptsApiKey: false,
    });
  });
});

describe("isOAuthOnly", () => {
  it("separates sign-in-only from dual-auth", () => {
    expect(isOAuthOnly({ signInLabel: "", providerLabel: "", acceptsApiKey: false })).toBe(true);
    expect(isOAuthOnly({ signInLabel: "", providerLabel: "Anthropic", acceptsApiKey: true })).toBe(
      false,
    );
  });

  it("treats an unclassified provider as key-taking", () => {
    // The safe direction: offer a key field rather than hide one (#429).
    expect(isOAuthOnly(undefined)).toBe(false);
  });
});

describe("the pre-registry seed", () => {
  it("covers only the provider that ships sign-in-only", () => {
    expect(SEED_OAUTH_ONLY_PROVIDERS).toEqual(["openai-codex"]);
  });

  it("does not pre-declare a dual-auth provider as key-less", () => {
    expect(SEED_PROVIDER_AUTH_CAPS.anthropic).toBeUndefined();
    expect(isOAuthOnly(SEED_PROVIDER_AUTH_CAPS.anthropic)).toBe(false);
  });
});
