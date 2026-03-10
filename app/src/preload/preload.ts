import { contextBridge, ipcRenderer } from "electron";

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

export interface ExtensionUIRequest {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
  notifyType?: "info" | "warning" | "error";
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  text?: string;
}

export interface GxypiAPI {
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  abort(): Promise<void>;
  newSession(): Promise<{ cancelled: boolean }>;
  getState(): Promise<unknown>;
  getCommands(): Promise<unknown>;
  respondToUiRequest(id: string, response: Record<string, unknown>): void;
  loadConfig(): Promise<unknown>;
  saveConfig(config: unknown): Promise<void>;
  restartAgent(): Promise<void>;
  selectDirectory(): Promise<string | null>;
  onAgentEvent(callback: (event: AgentEvent) => void): () => void;
  onUiRequest(callback: (request: ExtensionUIRequest) => void): () => void;
  onAgentStatus(
    callback: (status: "running" | "stopped" | "error", msg?: string) => void
  ): () => void;
  onToggleSidebar(callback: () => void): () => void;
}

const api: GxypiAPI = {
  prompt: (message) => ipcRenderer.invoke("agent:prompt", message),
  steer: (message) => ipcRenderer.invoke("agent:steer", message),
  abort: () => ipcRenderer.invoke("agent:abort"),
  newSession: () => ipcRenderer.invoke("agent:new-session"),
  getState: () => ipcRenderer.invoke("agent:get-state"),
  getCommands: () => ipcRenderer.invoke("agent:get-commands"),

  respondToUiRequest: (id, response) => {
    ipcRenderer.send("agent:ui-response", {
      type: "extension_ui_response",
      id,
      ...response,
    });
  },

  loadConfig: () => ipcRenderer.invoke("config:load"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  restartAgent: () => ipcRenderer.invoke("agent:restart"),
  selectDirectory: () => ipcRenderer.invoke("dialog:select-directory"),

  onAgentEvent: (callback) => {
    const handler = (_e: unknown, event: AgentEvent) => callback(event);
    ipcRenderer.on("agent:event", handler);
    return () => ipcRenderer.removeListener("agent:event", handler);
  },

  onUiRequest: (callback) => {
    const handler = (_e: unknown, request: ExtensionUIRequest) =>
      callback(request);
    ipcRenderer.on("agent:ui-request", handler);
    return () => ipcRenderer.removeListener("agent:ui-request", handler);
  },

  onAgentStatus: (callback) => {
    const handler = (
      _e: unknown,
      status: "running" | "stopped" | "error",
      msg?: string
    ) => callback(status, msg);
    ipcRenderer.on("agent:status", handler);
    return () => ipcRenderer.removeListener("agent:status", handler);
  },

  onToggleSidebar: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("view:toggle-sidebar", handler);
    return () =>
      ipcRenderer.removeListener("view:toggle-sidebar", handler);
  },
};

contextBridge.exposeInMainWorld("gxypi", api);
