import { renderMarkdown } from "./message.js";

export class ChatPanel {
  private messagesEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private currentAssistant: HTMLElement | null = null;
  private currentBody: HTMLElement | null = null;
  private currentText = "";
  private autoScroll = true;
  private toolCards = new Map<string, HTMLElement>();

  onSubmit: ((text: string) => void) | null = null;
  onAbort: (() => void) | null = null;

  constructor(
    messagesEl: HTMLElement,
    inputEl: HTMLTextAreaElement,
    sendBtn: HTMLButtonElement
  ) {
    this.messagesEl = messagesEl;
    this.inputEl = inputEl;
    this.sendBtn = sendBtn;

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
    });

    this.sendBtn.addEventListener("click", () => this.submit());

    // Auto-resize textarea
    this.inputEl.addEventListener("input", () => {
      this.inputEl.style.height = "auto";
      this.inputEl.style.height =
        Math.min(this.inputEl.scrollHeight, 120) + "px";
    });

    // Scroll-lock detection
    this.messagesEl.addEventListener("scroll", () => {
      const el = this.messagesEl;
      this.autoScroll =
        el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    });
  }

  private submit(): void {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    this.inputEl.style.height = "auto";
    this.onSubmit?.(text);
  }

  private scrollToBottom(): void {
    if (this.autoScroll) {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
  }

  addUserMessage(text: string): void {
    const msg = document.createElement("div");
    msg.className = "message user";

    const header = document.createElement("div");
    header.className = "message-header";
    header.textContent = "You";

    const body = document.createElement("div");
    body.className = "message-body";
    body.textContent = text;

    msg.appendChild(header);
    msg.appendChild(body);
    this.messagesEl.appendChild(msg);
    this.scrollToBottom();
  }

  startAssistantMessage(): void {
    this.currentText = "";
    this.toolCards.clear();

    const msg = document.createElement("div");
    msg.className = "message assistant";

    const header = document.createElement("div");
    header.className = "message-header";
    header.textContent = "gxypi";

    const body = document.createElement("div");
    body.className = "message-body";

    // Add streaming cursor
    const cursor = document.createElement("span");
    cursor.className = "streaming-cursor";
    body.appendChild(cursor);

    msg.appendChild(header);
    msg.appendChild(body);
    this.messagesEl.appendChild(msg);

    this.currentAssistant = msg;
    this.currentBody = body;
    this.scrollToBottom();
  }

  appendDelta(delta: string): void {
    if (!this.currentBody) return;
    this.currentText += delta;

    // Re-render markdown with cursor
    this.currentBody.innerHTML = renderMarkdown(this.currentText);
    const cursor = document.createElement("span");
    cursor.className = "streaming-cursor";
    this.currentBody.appendChild(cursor);

    this.scrollToBottom();
  }

  finishAssistantMessage(): void {
    if (this.currentBody && this.currentText) {
      this.currentBody.innerHTML = renderMarkdown(this.currentText);
    }
    this.currentAssistant = null;
    this.currentBody = null;
    this.currentText = "";
    this.scrollToBottom();
  }

  addToolCard(toolName: string, status: "running" | "done" | "error"): void {
    if (!this.currentAssistant) return;

    const card = document.createElement("div");
    card.className = "tool-card";

    const header = document.createElement("div");
    header.className = "tool-header";

    const icon = document.createElement("span");
    icon.className = "tool-icon";
    icon.textContent = "⚙";

    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = toolName.replace(/^galaxy_/, "").replace(/_/g, " ");

    const statusEl = document.createElement("span");
    statusEl.className = `tool-status ${status}`;
    statusEl.textContent = status === "running" ? "running..." : status;

    header.appendChild(icon);
    header.appendChild(name);
    header.appendChild(statusEl);

    const body = document.createElement("div");
    body.className = "tool-body";

    header.addEventListener("click", () => {
      card.classList.toggle("expanded");
    });

    card.appendChild(header);
    card.appendChild(body);

    // Insert before the message body (text), or append to message
    const bodyEl = this.currentAssistant.querySelector(".message-body");
    if (bodyEl) {
      this.currentAssistant.insertBefore(card, bodyEl);
    } else {
      this.currentAssistant.appendChild(card);
    }

    this.toolCards.set(toolName, card);
    this.scrollToBottom();
  }

  updateToolCard(
    toolName: string,
    status: "done" | "error",
    result?: string
  ): void {
    const card = this.toolCards.get(toolName);
    if (!card) return;

    const statusEl = card.querySelector(".tool-status");
    if (statusEl) {
      statusEl.className = `tool-status ${status}`;
      statusEl.textContent = status;
    }

    if (result) {
      const body = card.querySelector(".tool-body");
      if (body) {
        const text =
          typeof result === "string" ? result : JSON.stringify(result, null, 2);
        body.textContent = text.slice(0, 500);
      }
    }
  }

  // Used by inline confirm cards
  appendElement(el: HTMLElement): void {
    if (this.currentAssistant) {
      this.currentAssistant.appendChild(el);
    } else {
      this.messagesEl.appendChild(el);
    }
    this.scrollToBottom();
  }
}
