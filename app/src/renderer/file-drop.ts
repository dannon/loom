/** File paths dragged from Orbit's Files pane. */
export const ORBIT_FILE_PATH_TYPE = "application/x-orbit-file-path";

/** File-tree paths use `/` separators on every platform. */
export function absoluteFilePath(cwd: string, relPath: string): string {
  const separator = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  return `${cwd.replace(/[\\/]$/, "")}${separator}${relPath.replace(/\//g, separator)}`;
}

/** Keep spaces, quotes and newlines in a path unambiguous in a prompt. */
export function filePathText(path: string): string {
  return JSON.stringify(path);
}

export interface DraftInsertion {
  value: string;
  caret: number;
}

/** Insert at the current selection without replacing the rest of the draft. */
export function insertFilePaths(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  paths: readonly string[],
): DraftInsertion {
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  const prefix = before && !/\s$/.test(before) ? " " : "";
  const suffix = after && !/^\s/.test(after) ? " " : "";
  const inserted = prefix + paths.map(filePathText).join("\n") + suffix;
  return {
    value: before + inserted + after,
    caret: before.length + inserted.length - suffix.length,
  };
}

function isFilePathDrag(transfer: DataTransfer | null): boolean {
  return (
    !!transfer &&
    (transfer.types.includes(ORBIT_FILE_PATH_TYPE) ||
      transfer.types.includes("Files") ||
      transfer.files.length > 0)
  );
}

/** A drop edits the draft only; sending remains an explicit user action. */
export function attachFilePathDrop(
  input: HTMLTextAreaElement,
  getPathForFile: (file: File) => string,
  onUnavailable: () => void,
): void {
  input.addEventListener("dragover", (event) => {
    if (!isFilePathDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer!.dropEffect = "copy";
    input.classList.add("file-drop-target");
  });

  input.addEventListener("dragleave", () => input.classList.remove("file-drop-target"));
  input.addEventListener("drop", (event) => {
    input.classList.remove("file-drop-target");
    const transfer = event.dataTransfer;
    if (!isFilePathDrag(transfer)) return;
    event.preventDefault(); // Do not navigate away or paste file contents.

    const fromFilesPane = transfer!.getData(ORBIT_FILE_PATH_TYPE);
    const paths = fromFilesPane
      ? [fromFilesPane]
      : Array.from(transfer!.files, (file) => {
          try {
            return getPathForFile(file);
          } catch {
            return "";
          }
        }).filter(Boolean);
    if (!paths.length) {
      onUnavailable();
      return;
    }

    const result = insertFilePaths(input.value, input.selectionStart, input.selectionEnd, paths);
    input.value = result.value;
    input.setSelectionRange(result.caret, result.caret);
    input.dispatchEvent(new input.ownerDocument.defaultView!.Event("input", { bubbles: true }));
    input.focus();
  });
}
