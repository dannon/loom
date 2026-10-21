/**
 * Hosted Orbit's page: sign in if needed, list the user's conversations, and mount the browser shell
 * on the one in the URL, talking to the host over a WebSocket instead of to a worker in the page.
 */
import { mountOrbitBrowser } from "@galaxyproject/orbit-browser";

import { socketWorker } from "./socket-worker";

interface Me {
  sub: string;
  galaxyUrl: string;
}
interface Listed {
  id: string;
  title: string | null;
  lastActiveAt: string;
}

const signIn = () => {
  location.href = `/auth/login?return=${encodeURIComponent(location.pathname)}`;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (response.status === 401) {
    signIn();
    throw new Error("Signing in");
  }
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

const open = (id: string) => location.assign(`/c/${id}`);

async function newConversation(): Promise<void> {
  open((await api<{ id: string }>("/api/conversations", { method: "POST" })).id);
}

function sidebar(list: Listed[], current: string): HTMLElement {
  const nav = document.createElement("nav");
  nav.id = "conversations";
  const fresh = document.createElement("button");
  fresh.textContent = "New conversation";
  fresh.addEventListener("click", () => void newConversation());
  nav.append(fresh);
  for (const conversation of list) {
    const link = document.createElement("a");
    link.href = `/c/${conversation.id}`;
    link.textContent = conversation.title ?? `Conversation of ${new Date(conversation.lastActiveAt).toLocaleString()}`;
    if (conversation.id === current) link.setAttribute("aria-current", "page");
    nav.append(link);
  }
  const out = document.createElement("form");
  out.method = "post";
  out.action = "/auth/logout";
  const button = document.createElement("button");
  button.textContent = "Sign out";
  out.append(button);
  nav.append(out);
  return nav;
}

async function start(): Promise<void> {
  const me = await api<Me>("/api/me");
  const list = await api<Listed[]>("/api/conversations");
  const current = location.pathname.match(/^\/c\/([0-9a-f-]{36})$/)?.[1];
  if (!current) {
    // Pick up where the user left off, or start their first conversation.
    if (list[0]) open(list[0].id);
    else await newConversation();
    return;
  }
  document.body.prepend(sidebar(list, current));
  const app = document.getElementById("app")!;
  await mountOrbitBrowser(app, {
    galaxyRoot: me.galaxyUrl,
    pyodideURL: "",
    // The conversation lives on the host; the shell's own Galaxy history lookup has nothing to find.
    launch: async () => ({ historyId: current }),
    createWorker: () =>
      socketWorker({
        url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
        conversationId: current,
        moved: open,
        signedOut: signIn,
      }),
  });
}

void start();
