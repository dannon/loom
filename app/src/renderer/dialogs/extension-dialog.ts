import type { ExtensionUIRequest } from "../../preload/preload.js";
import type { ChatPanel } from "../chat/chat-panel.js";

const gxypi = window.gxypi;

const overlay = document.getElementById("modal-overlay")!;
const container = document.getElementById("modal-container")!;
const toastContainer = document.getElementById("toast-container")!;

export function showToast(
  message: string,
  type: "info" | "warning" | "error" = "info"
): void {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function showModal(): void {
  overlay.classList.remove("hidden");
}

function hideModal(): void {
  overlay.classList.add("hidden");
  container.innerHTML = "";
}

function showSelectModal(
  id: string,
  title: string,
  options: string[]
): void {
  container.innerHTML = "";

  const titleEl = document.createElement("div");
  titleEl.className = "modal-title";
  titleEl.textContent = title;
  container.appendChild(titleEl);

  options.forEach((option) => {
    const optEl = document.createElement("div");
    optEl.className = "modal-option";
    optEl.textContent = option;
    optEl.addEventListener("click", () => {
      hideModal();
      gxypi.respondToUiRequest(id, { value: option });
    });
    container.appendChild(optEl);
  });

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  actions.style.marginTop = "16px";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "modal-btn modal-btn-secondary";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    hideModal();
    gxypi.respondToUiRequest(id, { cancelled: true });
  });
  actions.appendChild(cancelBtn);
  container.appendChild(actions);

  showModal();
}

function showInputModal(
  id: string,
  title: string,
  placeholder?: string
): void {
  container.innerHTML = "";

  const titleEl = document.createElement("div");
  titleEl.className = "modal-title";
  titleEl.textContent = title;
  container.appendChild(titleEl);

  const input = document.createElement("input");
  input.className = "modal-input";
  input.type = "text";
  if (placeholder) input.placeholder = placeholder;
  container.appendChild(input);

  const actions = document.createElement("div");
  actions.className = "modal-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "modal-btn modal-btn-secondary";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    hideModal();
    gxypi.respondToUiRequest(id, { cancelled: true });
  });

  const submitBtn = document.createElement("button");
  submitBtn.className = "modal-btn modal-btn-primary";
  submitBtn.textContent = "Submit";
  submitBtn.addEventListener("click", () => {
    const value = input.value.trim();
    hideModal();
    if (value) {
      gxypi.respondToUiRequest(id, { value });
    } else {
      gxypi.respondToUiRequest(id, { cancelled: true });
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitBtn.click();
    if (e.key === "Escape") cancelBtn.click();
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(submitBtn);
  container.appendChild(actions);

  showModal();
  input.focus();
}

function showEditorModal(
  id: string,
  title: string,
  prefill?: string
): void {
  container.innerHTML = "";

  const titleEl = document.createElement("div");
  titleEl.className = "modal-title";
  titleEl.textContent = title;
  container.appendChild(titleEl);

  const textarea = document.createElement("textarea");
  textarea.className = "modal-textarea";
  if (prefill) textarea.value = prefill;
  container.appendChild(textarea);

  const actions = document.createElement("div");
  actions.className = "modal-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "modal-btn modal-btn-secondary";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    hideModal();
    gxypi.respondToUiRequest(id, { cancelled: true });
  });

  const submitBtn = document.createElement("button");
  submitBtn.className = "modal-btn modal-btn-primary";
  submitBtn.textContent = "Save";
  submitBtn.addEventListener("click", () => {
    hideModal();
    gxypi.respondToUiRequest(id, { value: textarea.value });
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(submitBtn);
  container.appendChild(actions);

  showModal();
  textarea.focus();
}

function showConfirmInline(
  id: string,
  title: string,
  message: string,
  chatPanel: ChatPanel
): void {
  const card = document.createElement("div");
  card.className = "confirm-card";

  const titleEl = document.createElement("div");
  titleEl.className = "confirm-title";
  titleEl.textContent = title;

  const msgEl = document.createElement("div");
  msgEl.className = "confirm-message";
  msgEl.textContent = message;

  const actions = document.createElement("div");
  actions.className = "confirm-actions";

  const denyBtn = document.createElement("button");
  denyBtn.className = "modal-btn modal-btn-secondary";
  denyBtn.textContent = "Deny";
  denyBtn.addEventListener("click", () => {
    card.style.opacity = "0.5";
    card.style.pointerEvents = "none";
    gxypi.respondToUiRequest(id, { confirmed: false });
  });

  const allowBtn = document.createElement("button");
  allowBtn.className = "modal-btn modal-btn-primary";
  allowBtn.textContent = "Allow";
  allowBtn.addEventListener("click", () => {
    card.style.opacity = "0.5";
    card.style.pointerEvents = "none";
    gxypi.respondToUiRequest(id, { confirmed: true });
  });

  actions.appendChild(denyBtn);
  actions.appendChild(allowBtn);

  card.appendChild(titleEl);
  card.appendChild(msgEl);
  card.appendChild(actions);

  chatPanel.appendElement(card);
}

export function handleExtensionUI(
  request: ExtensionUIRequest,
  chatPanel: ChatPanel
): void {
  const { id, method } = request;

  switch (method) {
    case "select":
      showSelectModal(id, request.title || "Select", request.options || []);
      break;

    case "confirm":
      showConfirmInline(
        id,
        request.title || "Confirm",
        request.message || "",
        chatPanel
      );
      break;

    case "input":
      showInputModal(id, request.title || "Input", request.placeholder);
      break;

    case "editor":
      showEditorModal(id, request.title || "Editor", request.prefill);
      break;

    case "notify":
      showToast(
        request.message || "",
        request.notifyType || "info"
      );
      break;

    // setWidget, setStatus, setTitle handled in app.ts
  }
}

// Close modal on overlay click
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) {
    hideModal();
  }
});

// Close modal on Escape
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !overlay.classList.contains("hidden")) {
    hideModal();
  }
});
