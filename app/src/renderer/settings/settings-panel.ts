const gxypi = window.gxypi;

interface GxypiConfig {
  llm?: {
    provider?: string;
    apiKey?: string;
    model?: string;
  };
  galaxy?: {
    active: string | null;
    profiles: Record<string, { url: string; apiKey: string }>;
  };
}

export async function showSettingsPanel(): Promise<void> {
  const existing = document.querySelector(".settings-overlay");
  if (existing) existing.remove();

  const config: GxypiConfig = (await gxypi.loadConfig()) as GxypiConfig;

  const overlay = document.createElement("div");
  overlay.className = "settings-overlay";

  const panel = document.createElement("div");
  panel.className = "settings-panel";

  panel.innerHTML = `
    <div class="settings-title">Settings</div>

    <div class="settings-section">
      <div class="settings-section-title">LLM Provider</div>
      <div class="settings-row">
        <label>Provider</label>
        <select id="settings-provider">
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
          <option value="google">Google</option>
          <option value="mistral">Mistral</option>
          <option value="groq">Groq</option>
          <option value="xai">xAI</option>
        </select>
      </div>
      <div class="settings-row">
        <label>API Key</label>
        <input id="settings-api-key" type="password" placeholder="sk-..." />
      </div>
      <div class="settings-row">
        <label>Model</label>
        <input id="settings-model" type="text" placeholder="Optional model override" />
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Galaxy Profiles</div>
      <div id="settings-profiles"></div>
      <div style="margin-top: 8px">
        <button class="modal-btn modal-btn-secondary" id="settings-add-profile">Add Profile</button>
      </div>
    </div>

    <div class="modal-actions" style="margin-top: 20px">
      <button class="modal-btn modal-btn-secondary" id="settings-cancel">Cancel</button>
      <button class="modal-btn modal-btn-primary" id="settings-save">Save & Restart</button>
    </div>
  `;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // Populate current values
  const providerSelect = panel.querySelector(
    "#settings-provider"
  ) as HTMLSelectElement;
  const apiKeyInput = panel.querySelector(
    "#settings-api-key"
  ) as HTMLInputElement;
  const modelInput = panel.querySelector(
    "#settings-model"
  ) as HTMLInputElement;
  const profilesContainer = panel.querySelector(
    "#settings-profiles"
  ) as HTMLElement;

  if (config.llm?.provider) providerSelect.value = config.llm.provider;
  if (config.llm?.apiKey) apiKeyInput.value = config.llm.apiKey;
  if (config.llm?.model) modelInput.value = config.llm.model;

  function renderProfiles(): void {
    profilesContainer.innerHTML = "";
    const profiles = config.galaxy?.profiles || {};
    const active = config.galaxy?.active;

    Object.entries(profiles).forEach(([name, profile]) => {
      const row = document.createElement("div");
      row.className = "settings-row";
      row.style.justifyContent = "space-between";

      const info = document.createElement("span");
      info.style.fontSize = "13px";
      info.textContent = `${name === active ? "* " : ""}${name} — ${profile.url}`;

      const removeBtn = document.createElement("button");
      removeBtn.className = "modal-btn modal-btn-secondary";
      removeBtn.style.fontSize = "11px";
      removeBtn.style.padding = "4px 8px";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => {
        delete profiles[name];
        if (config.galaxy?.active === name) {
          config.galaxy.active = Object.keys(profiles)[0] || null;
        }
        renderProfiles();
      });

      row.appendChild(info);
      row.appendChild(removeBtn);
      profilesContainer.appendChild(row);
    });
  }

  renderProfiles();

  panel.querySelector("#settings-add-profile")!.addEventListener("click", () => {
    const url = prompt("Galaxy Server URL:", "https://usegalaxy.org");
    if (!url) return;
    const apiKey = prompt("API Key:");
    if (!apiKey) return;

    let name: string;
    try {
      const parsed = new URL(url);
      name = parsed.hostname.replace(/\./g, "-");
    } catch {
      name = "galaxy";
    }

    if (!config.galaxy) {
      config.galaxy = { active: null, profiles: {} };
    }
    config.galaxy.profiles[name] = { url, apiKey };
    if (!config.galaxy.active) config.galaxy.active = name;
    renderProfiles();
  });

  panel.querySelector("#settings-cancel")!.addEventListener("click", () => {
    overlay.remove();
  });

  panel.querySelector("#settings-save")!.addEventListener("click", async () => {
    config.llm = {
      provider: providerSelect.value,
      apiKey: apiKeyInput.value || undefined,
      model: modelInput.value || undefined,
    };

    await gxypi.saveConfig(config);
    overlay.remove();
    await gxypi.restartAgent();
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
}
