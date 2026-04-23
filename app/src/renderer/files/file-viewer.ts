/**
 * FileViewer — reads/edits files opened from the FilesPanel.
 *
 * Text files get an editor + optional markdown preview. Images render inline.
 * Binary files show a "cannot preview" placeholder. Save is gated on the
 * file being text and dirty.
 */

import { marked } from "marked";

type FileKind = "text" | "image" | "binary";

const TEXT_EXTS = new Set([
  ".md", ".txt", ".py", ".json", ".jsonl", ".csv", ".tsv", ".yml", ".yaml",
  ".toml", ".js", ".ts", ".sh", ".log",
]);

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);

function extOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

function kindOf(path: string): FileKind {
  const ext = extOf(path);
  if (!ext) return "text";                    // no extension → treat as text
  if (TEXT_EXTS.has(ext)) return "text";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "binary";
}

function mimeForImage(ext: string): string {
  switch (ext) {
    case ".png":  return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif":  return "image/gif";
    case ".svg":  return "image/svg+xml";
    case ".webp": return "image/webp";
    default:      return "application/octet-stream";
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export class FileViewer {
  private readonly container: HTMLElement;
  private currentPath: string | null = null;
  private currentKind: FileKind | null = null;
  private dirty = false;
  private editor: HTMLTextAreaElement | null = null;
  private preview: HTMLDivElement | null = null;
  private saveBtn: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private editBtn: HTMLButtonElement | null = null;
  private previewBtn: HTMLButtonElement | null = null;
  private currentImageUrl: string | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  getCurrentPath(): string | null {
    return this.currentPath;
  }

  /**
   * Replace the container with a viewer for `relPath`. Returns true if the
   * open went ahead, false if the user cancelled due to unsaved changes.
   */
  open(relPath: string, bytes: Uint8Array, size: number): boolean {
    if (this.dirty && this.currentPath && this.currentPath !== relPath) {
      const ok = window.confirm(`Discard unsaved changes in ${this.currentPath}?`);
      if (!ok) return false;
    }
    this.teardownImage();
    this.container.innerHTML = "";
    this.currentPath = relPath;
    this.currentKind = kindOf(relPath);
    this.dirty = false;
    this.editor = null;
    this.preview = null;
    this.saveBtn = null;
    this.statusEl = null;
    this.editBtn = null;
    this.previewBtn = null;

    const root = document.createElement("div");
    root.className = "file-viewer-root";

    if (this.currentKind === "text") {
      this.renderText(root, relPath, bytes);
    } else if (this.currentKind === "image") {
      this.renderImage(root, relPath, bytes, size);
    } else {
      this.renderBinary(root, relPath, size);
    }

    this.container.appendChild(root);
    return true;
  }

  /** Clear the viewer (e.g. when the cwd changes). */
  close(): void {
    this.teardownImage();
    this.container.innerHTML = "";
    this.currentPath = null;
    this.currentKind = null;
    this.dirty = false;
    this.editor = null;
    this.preview = null;
    this.saveBtn = null;
    this.statusEl = null;
    this.editBtn = null;
    this.previewBtn = null;
  }

  private teardownImage(): void {
    if (this.currentImageUrl) {
      URL.revokeObjectURL(this.currentImageUrl);
      this.currentImageUrl = null;
    }
  }

  private renderText(root: HTMLElement, relPath: string, bytes: Uint8Array): void {
    const ext = extOf(relPath);
    const isMarkdown = ext === ".md";
    const text = new TextDecoder("utf-8").decode(bytes);

    // Toolbar ---------------------------------------------------------
    const toolbar = document.createElement("div");
    toolbar.className = "file-viewer-toolbar";

    const filename = document.createElement("span");
    filename.className = "file-viewer-filename";
    filename.textContent = relPath;
    filename.title = relPath;
    toolbar.appendChild(filename);

    // Preview/Edit toggle (markdown only)
    if (isMarkdown) {
      const editBtn = document.createElement("button");
      editBtn.className = "file-viewer-btn";
      editBtn.textContent = "Edit";
      const previewBtn = document.createElement("button");
      previewBtn.className = "file-viewer-btn";
      previewBtn.textContent = "Preview";

      editBtn.addEventListener("click", () => this.setMode("edit"));
      previewBtn.addEventListener("click", () => this.setMode("preview"));

      toolbar.appendChild(editBtn);
      toolbar.appendChild(previewBtn);

      this.editBtn = editBtn;
      this.previewBtn = previewBtn;
    }

    const saveBtn = document.createElement("button");
    saveBtn.className = "file-viewer-btn";
    saveBtn.textContent = "Save";
    saveBtn.disabled = true;
    saveBtn.addEventListener("click", () => void this.save());
    toolbar.appendChild(saveBtn);
    this.saveBtn = saveBtn;

    const status = document.createElement("span");
    status.className = "file-viewer-status saved";
    status.textContent = "Saved";
    toolbar.appendChild(status);
    this.statusEl = status;

    root.appendChild(toolbar);

    // Body ------------------------------------------------------------
    const body = document.createElement("div");
    body.className = "file-viewer-body";

    const editor = document.createElement("textarea");
    editor.className = "file-viewer-editor";
    editor.spellcheck = false;
    editor.value = text;
    editor.addEventListener("input", () => this.markDirty());
    editor.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        void this.save();
      }
    });
    this.editor = editor;

    const preview = document.createElement("div");
    preview.className = "file-viewer-preview result-markdown";
    this.preview = preview;

    body.appendChild(editor);
    body.appendChild(preview);
    root.appendChild(body);

    // Default mode: preview for .md, edit otherwise.
    this.setMode(isMarkdown ? "preview" : "edit");
  }

  private setMode(mode: "edit" | "preview"): void {
    if (!this.editor || !this.preview) return;
    if (mode === "preview") {
      // Render preview from current (possibly dirty) editor contents.
      const html = marked.parse(this.editor.value, { async: false }) as string;
      this.preview.innerHTML = html;
      this.editor.classList.add("hidden");
      this.preview.classList.remove("hidden");
      if (this.editBtn) this.editBtn.classList.remove("active");
      if (this.previewBtn) this.previewBtn.classList.add("active");
    } else {
      this.preview.classList.add("hidden");
      this.editor.classList.remove("hidden");
      if (this.editBtn) this.editBtn.classList.add("active");
      if (this.previewBtn) this.previewBtn.classList.remove("active");
    }
  }

  private markDirty(): void {
    if (!this.dirty) {
      this.dirty = true;
      if (this.saveBtn) this.saveBtn.disabled = false;
      if (this.statusEl) {
        this.statusEl.textContent = "\u25CF Modified";
        this.statusEl.className = "file-viewer-status dirty";
      }
    }
  }

  private async save(): Promise<void> {
    if (!this.editor || !this.currentPath) return;
    const path = this.currentPath;
    const content = this.editor.value;
    if (this.statusEl) {
      this.statusEl.textContent = "Saving…";
      this.statusEl.className = "file-viewer-status";
    }
    try {
      const res = await window.orbit.writeFile(path, content);
      if (res.ok) {
        // Guard: the user may have switched files mid-save.
        if (this.currentPath !== path) return;
        this.dirty = false;
        if (this.saveBtn) this.saveBtn.disabled = true;
        if (this.statusEl) {
          this.statusEl.textContent = "Saved";
          this.statusEl.className = "file-viewer-status saved";
        }
      } else {
        if (this.statusEl) {
          this.statusEl.textContent = `Error: ${res.error}`;
          this.statusEl.className = "file-viewer-status error";
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.statusEl) {
        this.statusEl.textContent = `Error: ${msg}`;
        this.statusEl.className = "file-viewer-status error";
      }
    }
  }

  private renderImage(
    root: HTMLElement,
    relPath: string,
    bytes: Uint8Array,
    size: number,
  ): void {
    const toolbar = document.createElement("div");
    toolbar.className = "file-viewer-toolbar";
    const filename = document.createElement("span");
    filename.className = "file-viewer-filename";
    filename.textContent = relPath;
    filename.title = relPath;
    toolbar.appendChild(filename);
    const sizeLabel = document.createElement("span");
    sizeLabel.className = "file-viewer-status";
    sizeLabel.textContent = formatBytes(size);
    toolbar.appendChild(sizeLabel);
    root.appendChild(toolbar);

    const wrap = document.createElement("div");
    wrap.className = "file-viewer-image-wrap";

    const ext = extOf(relPath);
    const mime = mimeForImage(ext);
    // Copy into a fresh ArrayBuffer to satisfy Blob's BlobPart typing, which
    // requires a plain ArrayBuffer (not ArrayBufferLike).
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const blob = new Blob([buffer], { type: mime });
    const url = URL.createObjectURL(blob);
    this.currentImageUrl = url;

    const img = document.createElement("img");
    img.src = url;
    img.alt = relPath;
    wrap.appendChild(img);

    root.appendChild(wrap);
  }

  private renderBinary(root: HTMLElement, relPath: string, size: number): void {
    const toolbar = document.createElement("div");
    toolbar.className = "file-viewer-toolbar";
    const filename = document.createElement("span");
    filename.className = "file-viewer-filename";
    filename.textContent = relPath;
    filename.title = relPath;
    toolbar.appendChild(filename);
    root.appendChild(toolbar);

    const msg = document.createElement("div");
    msg.className = "file-viewer-binary";
    msg.textContent = `Cannot preview — binary file (${formatBytes(size)}).`;
    root.appendChild(msg);
  }
}
