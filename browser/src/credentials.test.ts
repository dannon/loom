import { describe, expect, it } from "vitest";
import { credentialProblem, providerById } from "./credentials";

describe("credentialProblem", () => {
    it("asks for a provider when nothing is chosen", () => {
        expect(credentialProblem(null)).toBeTruthy();
    });

    it("rejects a provider the registry does not know", () => {
        expect(credentialProblem({ provider: "nope" })).toContain("Unknown provider");
    });

    it("requires a key for a provider whose endpoint authenticates", () => {
        expect(credentialProblem({ provider: "openrouter", model: "openai/gpt-5.6-terra" }))
            .toContain("requires an API key");
    });

    it("accepts a keyed provider once the key and model are supplied", () => {
        expect(
            credentialProblem({
                provider: "openrouter",
                model: "openai/gpt-5.6-terra",
                apiKey: "k",
            }),
        ).toBeNull();
    });

    it("needs no key for the Galaxy proxy", () => {
        expect(credentialProblem({ provider: "galaxy" })).toBeNull();
    });

    it("lets a local server name its own model", () => {
        expect(providerById("local")?.free_model).toBe(true);
        expect(credentialProblem({ provider: "local" })).toBeNull();
    });
});
