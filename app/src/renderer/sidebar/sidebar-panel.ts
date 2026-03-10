// Widget key → friendly label
const WIDGET_LABELS: Record<string, string> = {
  "plan-view": "Analysis Plan",
  "status-view": "Status",
  "decisions-view": "Decisions",
  "notebook-view": "Notebook",
  "profiles-view": "Galaxy Profiles",
};

export class SidebarPanel {
  private container: HTMLElement;
  private widgets = new Map<string, HTMLElement>();
  private statuses = new Map<string, HTMLElement>();

  constructor(container: HTMLElement) {
    this.container = container;
  }

  updateWidget(key: string, lines: string[]): void {
    let section = this.widgets.get(key);

    if (!section) {
      section = this.createSection(key);
      this.widgets.set(key, section);
      this.container.appendChild(section);
    }

    const linesEl = section.querySelector(".widget-lines") as HTMLElement;
    if (linesEl) {
      linesEl.textContent = lines.join("\n");
    }
  }

  updateStatus(key: string, text?: string): void {
    if (!text) {
      // Clear status
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
      el.className = "widget-section";
      el.style.fontSize = "12px";
      el.style.color = "var(--text-dim)";
      this.statuses.set(key, el);
      // Insert status entries at the top
      this.container.insertBefore(el, this.container.firstChild);
    }
    el.textContent = text;
  }

  private createSection(key: string): HTMLElement {
    const section = document.createElement("div");
    section.className = "widget-section";

    const header = document.createElement("div");
    header.className = "widget-section-header";

    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.textContent = "▼";

    const label = document.createElement("span");
    label.textContent = WIDGET_LABELS[key] || key;

    header.appendChild(chevron);
    header.appendChild(label);

    header.addEventListener("click", () => {
      section.classList.toggle("collapsed");
    });

    const lines = document.createElement("div");
    lines.className = "widget-lines";

    section.appendChild(header);
    section.appendChild(lines);

    return section;
  }
}
