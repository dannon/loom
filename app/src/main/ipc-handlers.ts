import { ipcMain, dialog } from "electron";
import type { AgentManager } from "./agent.js";
import { loadConfig, saveConfig } from "./config.js";

export function registerIpcHandlers(agent: AgentManager): void {
  ipcMain.handle("agent:prompt", async (_e, message: string) => {
    agent.send({ type: "prompt", message });
  });

  ipcMain.handle("agent:steer", async (_e, message: string) => {
    agent.send({ type: "steer", message });
  });

  ipcMain.handle("agent:abort", async () => {
    agent.send({ type: "abort" });
  });

  ipcMain.handle("agent:new-session", async () => {
    return agent.sendCommand({ type: "new_session" });
  });

  ipcMain.handle("agent:get-state", async () => {
    return agent.sendCommand({ type: "get_state" });
  });

  ipcMain.handle("agent:get-commands", async () => {
    return agent.sendCommand({ type: "get_commands" });
  });

  ipcMain.on("agent:ui-response", (_e, response: Record<string, unknown>) => {
    agent.send(response);
  });

  ipcMain.handle("config:load", async () => {
    return loadConfig();
  });

  ipcMain.handle("config:save", async (_e, config) => {
    saveConfig(config);
  });

  ipcMain.handle("agent:restart", async () => {
    agent.stop();
    agent.start();
  });

  ipcMain.handle("dialog:select-directory", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    return result.filePaths[0] ?? null;
  });
}
