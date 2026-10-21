/**
 * The browser's WebSocket (brief H8). It speaks the browser shell's worker protocol (core's
 * worker.ts WorkerMessage/PageMessage), so the shell runs unchanged over it, with every message from
 * the page naming the conversation it's about. The socket authenticates by the session cookie, only
 * from Orbit's own origin, and checks the conversation belongs to the user on every message.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import type { WorkerMessage } from "../../../core/src/agent/worker";
import type { AuthContext } from "../auth/routes";
import { sessionOf } from "../auth/routes";
import { createConversation, getConversation } from "../dispatch/conversations";
import type { DispatchEvent, Dispatcher } from "../dispatch/dispatcher";
import type { FromWorker } from "../worker/protocol";
import { storedSnapshot } from "./snapshot";

/** What the page sends: the shell's PageMessage, plus the conversation it's for. */
type FromPage =
  | { type: "open"; conversationId: string }
  | { type: "submit"; conversationId: string; text: string }
  | { type: "stop"; conversationId: string }
  | { type: "confirmed"; conversationId: string; id: number; approved: boolean }
  | { type: "reset"; conversationId: string }
  | { type: "switch" | "export" | "saved"; conversationId: string; id: number };

/** Besides the shell's own messages: the conversation the page should move to after a reset. */
export type ToPage = WorkerMessage | { type: "moved"; conversationId: string };

export interface SocketContext {
  readonly auth: AuthContext;
  readonly dispatcher: Dispatcher;
  /** When set, turns are turned away with this notice: the kill switch. */
  readonly turnsDisabled?: string;
  readonly log?: (message: string) => void;
}

const MAX_MESSAGE_BYTES = 256 * 1024;

export class Sockets {
  readonly #c: SocketContext;
  readonly #server = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  /** Who is watching each conversation. */
  readonly #watching = new Map<string, Set<WebSocket>>();

  constructor(context: SocketContext) {
    this.#c = context;
  }

  /** Take /ws upgrades on `http`. */
  attach(http: Server): void {
    http.on("upgrade", (req, socket, head) => void this.#upgrade(req, socket, head));
  }

  /** The dispatcher's events, sent to every page watching the conversation. */
  deliver(conversationId: string, event: FromWorker | DispatchEvent): void {
    const watchers = this.#watching.get(conversationId);
    if (!watchers?.size) return;
    const message = this.#translate(conversationId, event);
    if (!message) return;
    const text = JSON.stringify(message);
    for (const ws of watchers) ws.send(text);
  }

  async #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const refuse = (status: string) => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    };
    if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") return refuse("404 Not Found");
    // A page on another site can open a WebSocket with the user's cookie; only Orbit's own may.
    if (req.headers.origin !== this.#c.auth.publicUrl.origin) return refuse("403 Forbidden");
    const session = await sessionOf(this.#c.auth, req).catch(() => undefined);
    if (!session) return refuse("401 Unauthorized");
    this.#server.handleUpgrade(req, socket, head, (ws) => this.#connected(ws, session.sub));
  }

  #connected(ws: WebSocket, sub: string): void {
    let watching: string | undefined;
    const send = (message: ToPage) => ws.send(JSON.stringify(message));
    const unwatch = () => {
      if (watching) this.#watching.get(watching)?.delete(ws);
      watching = undefined;
    };
    ws.on("close", unwatch);
    ws.on("message", (raw) => {
      let message: FromPage;
      try {
        message = JSON.parse(String(raw)) as FromPage;
      } catch {
        return;
      }
      this.#handle(message, sub, send, (id) => {
        unwatch();
        watching = id;
        const set = this.#watching.get(id) ?? new Set();
        set.add(ws);
        this.#watching.set(id, set);
      }).catch((error: Error) => {
        this.#c.log?.(`socket message failed: ${error.message}`);
        send({ type: "failed", message: "Orbit couldn't do that. Try again in a moment." });
      });
    });
  }

  async #handle(
    message: FromPage,
    sub: string,
    send: (message: ToPage) => void,
    watch: (conversationId: string) => void,
  ): Promise<void> {
    const { dispatcher } = this.#c;
    if (typeof message?.conversationId !== "string") return;
    // Every message, not just open: a page can name any conversation in any message.
    const conversation = await getConversation(this.#c.auth.pool, message.conversationId);
    if (!conversation || conversation.ownerSub !== sub) {
      send({ type: "failed", message: "That conversation isn't yours, or no longer exists." });
      return;
    }
    const id = conversation.id;
    switch (message.type) {
      case "open":
        watch(id);
        // A running worker sends its own snapshot, which every watcher redraws from; otherwise the
        // store has everything there is. Ready goes after a stored one: a snapshot clears the chat,
        // and with it the shell's ready line.
        if (!dispatcher.snapshot(id)) send({ type: "events", events: [await storedSnapshot(this.#c.auth.pool, conversation)] });
        send({ type: "ready", galaxy: "ok" });
        for (const ask of dispatcher.pendingAsks(id)) {
          const shown = this.#translate(id, { type: "ask", id: ask.id, request: ask.request });
          if (shown) send(shown);
        }
        return;
      case "submit":
        if (this.#c.turnsDisabled) {
          send({ type: "notice", text: this.#c.turnsDisabled, level: "warning" });
          return;
        }
        if (typeof message.text !== "string" || !message.text.trim()) return;
        await dispatcher.submit(id, message.text);
        return;
      case "stop":
        dispatcher.stop(id);
        return;
      case "confirmed":
        dispatcher.answer(id, Number(message.id), message.approved === true);
        return;
      case "reset": {
        // A new conversation; the old one stays in the list.
        const fresh = await createConversation(this.#c.auth.pool, sub);
        send({ type: "moved", conversationId: fresh.id });
        return;
      }
      case "switch":
      case "export":
      case "saved":
        send({ type: "reply", id: Number(message.id), error: "Hosted Orbit sets the model and keeps conversations itself." });
        return;
    }
  }

  /** The dispatcher's event as the shell's message, or nothing for what the page doesn't show. */
  #translate(conversationId: string, event: FromWorker | DispatchEvent): WorkerMessage | undefined {
    switch (event.type) {
      case "events":
        return { type: "events", events: event.events };
      case "ask":
        if (event.request.kind === "confirm") {
          return { type: "confirm", id: event.id, title: event.request.title, message: event.request.message };
        }
        // The shell only has a confirm dialog; anything else goes unanswered rather than hang.
        this.#c.dispatcher.answer(conversationId, event.id, undefined);
        return { type: "notice", text: "Orbit asked something this page can't show yet, so it went unanswered.", level: "warning" };
      case "ask-withdrawn":
        return { type: "withdrawn", id: event.id };
      case "notify":
        return { type: "notice", text: event.text, level: event.level };
      case "waiting":
        return { type: "notice", text: "Waiting for your other conversation's turn to finish.", level: "info" };
      case "worker-exit":
        // A lost lease means another host has the conversation; it says nothing to the user.
        if (event.code === 0 || event.code === 75) return undefined;
        return { type: "notice", text: "Orbit restarted this conversation; it picks up where it left off.", level: "warning" };
      default:
        return undefined;
    }
  }
}
