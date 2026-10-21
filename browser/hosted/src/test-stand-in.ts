/**
 * One local HTTP server standing in for both the model (under /v1/) and Galaxy, for tests that boot
 * real workers. The model follows a script keyed on words in the user's message; Galaxy answers a
 * history h1 and records every request.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { text, toolCall } from "../../core/src/agent/fake-model";

export interface Seen {
  readonly to: "model" | "galaxy";
  readonly method: string;
  readonly path: string;
  readonly lastRole?: string;
  readonly lastText?: string;
  /** The model request's most recent user message. */
  readonly userText?: string;
  /** What a Galaxy request authenticated with. */
  readonly authorization?: string;
  readonly apiKey?: string;
}

export interface StandIn {
  readonly origin: string;
  readonly seen: Seen[];
  modelCalls(): number;
  galaxyCalls(method: string, path: string): number;
  close(): Promise<void>;
}

export const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : (content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");

type Message = { role: string; content: unknown };

/**
 * The model's script. READ_H1 reads history h1, DELETE_H1 deletes it (the destructive gate asks
 * first), KEEP_GOING calls a tool after every result until a tool call is refused; anything else, and
 * any tool result, gets "ok".
 */
function modelAnswer(messages: Message[]): Response {
  const last = messages.at(-1)!;
  const said = textOf(last.content);
  const user = textOf(messages.filter((m) => m.role === "user").at(-1)?.content);
  if (last.role === "user" && said.includes("READ_H1")) return toolCall("get_history_details", { history_id: "h1" });
  if (last.role === "user" && said.includes("DELETE_H1")) {
    return toolCall("update_history", { history_id: "h1", deleted: true });
  }
  if (user.includes("KEEP_GOING") && (last.role === "user" || (last.role === "tool" && !said.includes("tool calls")))) {
    return toolCall("get_history_details", { history_id: "h1" }, `call_${messages.length}`);
  }
  return text("ok");
}

export async function startStandIn(): Promise<StandIn> {
  const seen: Seen[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = new URL(req.url!, "http://x").pathname;
    let answer: Response;
    if (path.startsWith("/v1/")) {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: Message[] };
      const last = body.messages.at(-1)!;
      seen.push({
        to: "model",
        method: req.method!,
        path,
        lastRole: last.role,
        lastText: textOf(last.content),
        userText: textOf(body.messages.filter((m) => m.role === "user").at(-1)?.content),
      });
      answer = modelAnswer(body.messages);
    } else {
      seen.push({
        to: "galaxy",
        method: req.method!,
        path,
        authorization: req.headers.authorization,
        apiKey: req.headers["x-api-key"] as string | undefined,
      });
      const sent = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { deleted?: boolean }) : {};
      answer =
        path === "/api/histories/h1"
          ? Response.json({ id: "h1", name: "one brain", deleted: sent.deleted === true })
          : path === "/api/histories"
            ? Response.json([{ id: "h1", name: "one brain" }])
            : path === "/api/pages" && req.method === "POST"
              ? Response.json({ id: `page-${seen.length}` })
              : Response.json({});
    }
    const headers: Record<string, string> = {};
    answer.headers.forEach((value, key) => (headers[key] = value));
    res.writeHead(answer.status, headers);
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    modelCalls: () => seen.filter((s) => s.to === "model").length,
    galaxyCalls: (method, path) => seen.filter((s) => s.to === "galaxy" && s.method === method && s.path === path).length,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
