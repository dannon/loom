#!/usr/bin/env node

import { main } from "@mariozechner/pi-coding-agent";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve extension paths relative to this script
const extensionPath = resolve(__dirname, "../extensions/galaxy-analyst");

// pi-mcp-adapter is what teaches Pi how to use MCP servers from mcp.json
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const mcpAdapterPath = dirname(require.resolve("pi-mcp-adapter/index.ts"));

// Ensure Galaxy MCP is configured before Pi starts
const agentDir = process.env.PI_CODING_AGENT_DIR
  || join(homedir(), ".pi", "agent");
const mcpConfigPath = join(agentDir, "mcp.json");

let mcpConfig = {};
if (existsSync(mcpConfigPath)) {
  mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
}

if (!mcpConfig.mcpServers?.galaxy) {
  mcpConfig.mcpServers = mcpConfig.mcpServers || {};
  mcpConfig.mcpServers.galaxy = {
    command: "uvx",
    args: ["galaxy-mcp"],
  };
  mkdirSync(dirname(mcpConfigPath), { recursive: true });
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
}

// Load Galaxy credentials from profiles (source of truth) or migrate from mcp.json
const profilesPath = join(agentDir, "galaxy-profiles.json");

if (!existsSync(profilesPath)) {
  // One-time migration: if mcp.json has Galaxy credentials, create a profile from them
  const galaxyEnv = mcpConfig.mcpServers?.galaxy?.env;
  if (galaxyEnv?.GALAXY_URL && galaxyEnv?.GALAXY_API_KEY) {
    const url = galaxyEnv.GALAXY_URL;
    const apiKey = galaxyEnv.GALAXY_API_KEY;
    // Derive profile name from hostname
    let profileName;
    try {
      const parsed = new URL(url);
      profileName = parsed.hostname.replace(/\./g, "-");
      if (parsed.port) profileName += `-${parsed.port}`;
    } catch {
      profileName = "default";
    }
    const profiles = {
      active: profileName,
      profiles: { [profileName]: { url, apiKey } },
    };
    mkdirSync(dirname(profilesPath), { recursive: true });
    writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
  }
}

// Load active profile into process.env
if (existsSync(profilesPath)) {
  try {
    const profiles = JSON.parse(readFileSync(profilesPath, "utf-8"));
    const active = profiles.profiles?.[profiles.active];
    if (active) {
      if (!process.env.GALAXY_URL) process.env.GALAXY_URL = active.url;
      if (!process.env.GALAXY_API_KEY) process.env.GALAXY_API_KEY = active.apiKey;

      // Keep mcp.json env block in sync with the active profile
      if (mcpConfig.mcpServers?.galaxy) {
        mcpConfig.mcpServers.galaxy.env = {
          GALAXY_URL: active.url,
          GALAXY_API_KEY: active.apiKey,
        };
        writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
      }
    }
  } catch {
    // Profiles file is corrupt — fall through, /connect still works
  }
}

// Build args: inject both extensions, pass through everything else
const args = ["-e", mcpAdapterPath, "-e", extensionPath, ...process.argv.slice(2)];

main(args);
