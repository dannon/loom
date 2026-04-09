// Strip ANSI escape sequences (color codes, cursor movement, etc.)
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// Tab definitions in display order
const TABS: { key: string; label: string; short: string }[] = [
  { key: "status-view", label: "Status", short: "Status" },
  { key: "plan-view", label: "Analysis Plan", short: "Plan" },
  { key: "decisions-view", label: "Decisions", short: "Decisions" },
  { key: "notebook-view", label: "Notebook", short: "Notebook" },
  { key: "profiles-view", label: "Galaxy Profiles", short: "Profiles" },
];

export class SidebarPanel {
  private container: HTMLElement;
  private tabBar: HTMLElement;
  private statusBar: HTMLElement;
  private contentArea: HTMLElement;
  private widgets = new Map<string, HTMLElement>();
  private statuses = new Map<string, HTMLElement>();
  private activeTab: string = "status-view";

  constructor(container: HTMLElement) {
    this.container = container;

    // Tab bar
    this.tabBar = document.createElement("div");
    this.tabBar.className = "sidebar-tabs";
    for (const tab of TABS) {
      const btn = document.createElement("button");
      btn.className = "sidebar-tab";
      btn.dataset.key = tab.key;
      btn.textContent = tab.short;
      btn.title = tab.label;
      btn.addEventListener("click", () => this.switchTab(tab.key));
      this.tabBar.appendChild(btn);
    }
    this.container.appendChild(this.tabBar);

    // Status bar (always visible, above content)
    this.statusBar = document.createElement("div");
    this.statusBar.className = "sidebar-status-bar";
    this.container.appendChild(this.statusBar);

    // Content area (shows active tab's widget)
    this.contentArea = document.createElement("div");
    this.contentArea.className = "sidebar-tab-content";
    this.container.appendChild(this.contentArea);

    // Create widget containers for each tab
    for (const tab of TABS) {
      const el = document.createElement("div");
      el.className = "widget-lines";
      el.dataset.key = tab.key;
      this.widgets.set(tab.key, el);
      this.contentArea.appendChild(el);
    }

    this.switchTab(this.activeTab);
  }

  switchTab(key: string): void {
    this.activeTab = key;

    // Update tab button active state
    for (const btn of this.tabBar.querySelectorAll<HTMLElement>(".sidebar-tab")) {
      btn.classList.toggle("active", btn.dataset.key === key);
    }

    // Show only the active widget
    for (const [wKey, el] of this.widgets) {
      el.style.display = wKey === key ? "" : "none";
    }
  }

  updateWidget(key: string, lines: string[]): void {
    let el = this.widgets.get(key);

    if (!el) {
      el = document.createElement("div");
      el.className = "widget-lines";
      el.dataset.key = key;
      this.widgets.set(key, el);
      this.contentArea.appendChild(el);
      if (key !== this.activeTab) {
        el.style.display = "none";
      }
    }

    el.textContent = stripAnsi(lines.join("\n"));

    // Auto-switch to the tab that just got content, so the user
    // sees results from the command they just ran
    this.switchTab(key);
  }

  updateStatus(key: string, text?: string): void {
    if (!text) {
      const el = this.statuses.get(key);
      if (el) {
        el.remove();
        this.statuses.delete(key);
      }
      return;
    }

    let el = this.statuses.get(key);
    if (!el) {
      el = document.createElement("div");
      el.className = "sidebar-status-item";
      this.statuses.set(key, el);
      this.statusBar.appendChild(el);
    }
    el.textContent = stripAnsi(text);
  }
}
