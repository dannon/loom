/**
 * A Worker for the shell's AgentClient that is really the host's WebSocket (brief H8). The client
 * only posts, listens and terminates, so this keeps that shape: page messages go out tagged with the
 * conversation, the host's answers come back as message events, and a dropped socket reconnects and
 * reopens the conversation, which redraws it from a fresh snapshot.
 */
import type { PageMessage, WorkerMessage } from "@galaxyproject/orbit-browser/worker";

type Incoming = WorkerMessage | { type: "moved"; conversationId: string };

export interface SocketWorkerOptions {
  readonly url: string;
  readonly conversationId: string;
  /** A reset made a new conversation: the page goes there. */
  readonly moved: (conversationId: string) => void;
  /** The socket was refused for want of a session. */
  readonly signedOut: () => void;
}

export function socketWorker(options: SocketWorkerOptions): Worker {
  let socket: WebSocket | undefined;
  let closed = false;
  let attempt = 0;
  // Sent while the socket was down; flushed, in order, once it's back.
  const outbox: string[] = [];
  const shim = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage(message: PageMessage) {
      // The shell's own open carries Galaxy and model settings the host decides; only the
      // conversation matters here.
      const tagged = message.type === "open" ? { type: "open" } : message;
      const text = JSON.stringify({ ...tagged, conversationId: options.conversationId });
      if (socket?.readyState === WebSocket.OPEN) socket.send(text);
      else outbox.push(text);
    },
    terminate() {
      closed = true;
      socket?.close();
    },
  };

  const deliver = (data: WorkerMessage) => shim.onmessage?.({ data } as MessageEvent);

  function connect() {
    const ws = new WebSocket(options.url);
    socket = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      attempt = 0;
      ws.send(JSON.stringify({ type: "open", conversationId: options.conversationId }));
      for (const text of outbox.splice(0)) ws.send(text);
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Incoming;
      if (message.type === "moved") options.moved(message.conversationId);
      else deliver(message);
    };
    ws.onclose = (event) => {
      if (closed) return;
      // Refused before it opened: most likely the session ended, which a reload can't fix.
      if (!opened && attempt >= 2) {
        options.signedOut();
        return;
      }
      if (opened && event.code !== 1000) {
        deliver({ type: "notice", text: "Lost the connection to Orbit; reconnecting...", level: "warning" });
      }
      attempt += 1;
      setTimeout(connect, Math.min(10_000, 500 * 2 ** attempt));
    };
  }

  connect();
  return shim as unknown as Worker;
}
