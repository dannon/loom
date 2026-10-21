import { describe, expect, it } from "vitest";

import { liteLlmModels } from "./litellm";

describe("model settings", () => {
  it("gives every user the service key, tagged with who they are", () => {
    const modelFor = liteLlmModels({ url: new URL("https://litellm.test"), key: "sk-service", model: "minimax" });
    expect(modelFor("user-a")).toEqual({ baseUrl: "https://litellm.test/v1", id: "minimax", apiKey: "sk-service", user: "user-a" });
    expect(modelFor("user-b").user).toBe("user-b");
  });

  it("keeps a path on LiteLLM's URL", () => {
    const modelFor = liteLlmModels({ url: new URL("https://example.org/litellm"), key: "k", model: "m" });
    expect(modelFor("u").baseUrl).toBe("https://example.org/litellm/v1");
  });
});
