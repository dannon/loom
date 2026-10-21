/**
 * Each conversation's record lives on a Galaxy page of its own, created as the user the first time a
 * worker boots for it. Slice 3's page binding (commit 7) will let Orbit create and bind pages itself;
 * until then the host makes one so the page record store has somewhere to write.
 */
import { fetchSameOriginOnly } from "../../../../shared/redirect-guard.js";
import type { TokenCache } from "../tokens/token-cache";
import type { ConversationRow } from "./conversations";

export function galaxyPageCreator(options: {
  readonly galaxyUrl: string;
  readonly tokens: TokenCache;
  readonly fetch?: typeof fetch;
}): (conversation: ConversationRow) => Promise<string> {
  return async (conversation) => {
    const token = await options.tokens.token(conversation.ownerSub);
    const response = await fetchSameOriginOnly(
      new URL("/api/pages", options.galaxyUrl).href,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          // Galaxy wants a slug unique per user, of lowercase letters, digits and dashes.
          slug: `orbit-${conversation.id.toLowerCase()}`,
          title: conversation.title ?? "Orbit conversation",
          content_format: "markdown",
          content: "",
        }),
      },
      { fetchImpl: options.fetch, serverLabel: "The Galaxy server" },
    );
    if (!response.ok) {
      throw new Error(`Galaxy refused to create the conversation's page: HTTP ${response.status}`);
    }
    const page = (await response.json()) as { id?: unknown };
    if (typeof page.id !== "string") throw new Error("Galaxy created the page but didn't say its id");
    return page.id;
  };
}
