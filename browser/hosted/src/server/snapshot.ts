/**
 * A conversation's snapshot read from its store, for a browser opening a conversation no worker is
 * running: what pi-durable's watchEvents would send first, minus the live state only a running
 * harness has (an unfinished run, tool slots, the inbox). Read without a lease, so it never takes the
 * conversation from a worker or counts against the user's live loop.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Cursor, EntryRecord, SnapshotEvent } from "@earendil-works/pi-durable";
import type { Pool } from "pg";

import type { ConversationRow } from "../dispatch/conversations";
import { PostgresStorage } from "../storage/postgres-storage";

export async function storedSnapshot(pool: Pool, conversation: ConversationRow): Promise<SnapshotEvent> {
  const entries: EntryRecord[] = [];
  if (conversation.durableConversationId !== null) {
    const storage = await PostgresStorage.open(pool, conversation.storeId);
    try {
      const query = { conversationId: Number(conversation.durableConversationId) as ConversationId };
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanEntries(query, 200, cursor, BACKGROUND_CONTEXT);
        entries.push(...page.items);
        cursor = page.next;
      } while (cursor !== undefined);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  }
  return {
    type: "snapshot",
    entries,
    tools: [],
    compactions: [],
    inbox: [],
    // The shell reads neither; pi-durable's own initial values aren't exported.
    agent: {} as SnapshotEvent["agent"],
    usage: {} as SnapshotEvent["usage"],
  };
}
