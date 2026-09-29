// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ORBIT_FILE_PATH_TYPE,
  absoluteFilePath,
  attachFilePathDrop,
  filePathText,
  insertFilePaths,
} from "../app/src/renderer/file-drop.js";
import { FilesPanel } from "../app/src/renderer/files/files-panel.js";

function drop(input: HTMLTextAreaElement, dataTransfer: DataTransfer): DragEvent {
  const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  input.dispatchEvent(event);
  return event;
}

describe("Orbit prompt file drops", () => {
  let input: HTMLTextAreaElement;

  beforeEach(() => {
    input = document.createElement("textarea");
    document.body.replaceChildren(input);
  });

  it("builds file-pane paths for Linux, macOS and Windows project directories", () => {
    expect(absoluteFilePath("/home/ada/project", "reads/R 1.fastq.gz")).toBe(
      "/home/ada/project/reads/R 1.fastq.gz",
    );
    expect(absoluteFilePath("/Users/ada/project/", "reads/R 1.fastq.gz")).toBe(
      "/Users/ada/project/reads/R 1.fastq.gz",
    );
    expect(absoluteFilePath("C:\\Users\\ada\\project", "reads/R 1.fastq.gz")).toBe(
      "C:\\Users\\ada\\project\\reads\\R 1.fastq.gz",
    );
  });

  it("quotes paths without losing spaces, quotes, backslashes or newlines", () => {
    expect(filePathText('/home/ada/reads/R "1"\n.fastq')).toBe(
      JSON.stringify('/home/ada/reads/R "1"\n.fastq'),
    );
    expect(filePathText("C:\\data\\R 1.fastq")).toBe('"C:\\\\data\\\\R 1.fastq"');
  });

  it("inserts several files at the caret while preserving the rest of the draft", () => {
    expect(
      insertFilePaths("Analyze with Galaxy", 7, 7, ["/home/ada/R 1.fastq", "/home/ada/R 2.fastq"]),
    ).toEqual({
      value: 'Analyze "/home/ada/R 1.fastq"\n"/home/ada/R 2.fastq" with Galaxy',
      caret: 51,
    });
    expect(insertFilePaths("Use old data", 4, 7, ["/tmp/new data.tsv"]).value).toBe(
      'Use "/tmp/new data.tsv" data',
    );
  });

  it("inserts OS-backed file paths and emits an input event without sending the prompt", () => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(["one"], "R 1.fastq"));
    dataTransfer.items.add(new File(["two"], "R 2.fastq"));
    const getPathForFile = vi.fn((file: File) => `/home/ada/reads/${file.name}`);
    const onUnavailable = vi.fn();
    const onInput = vi.fn();
    input.value = "Analyze ";
    input.setSelectionRange(input.value.length, input.value.length);
    input.addEventListener("input", onInput);
    attachFilePathDrop(input, getPathForFile, onUnavailable);

    const event = drop(input, dataTransfer);

    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe('Analyze "/home/ada/reads/R 1.fastq"\n"/home/ada/reads/R 2.fastq"');
    expect(getPathForFile).toHaveBeenCalledTimes(2);
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("inserts a path dragged from the Files pane without consulting Electron", () => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData(ORBIT_FILE_PATH_TYPE, "/home/ada/project/input.tsv");
    dataTransfer.setData("text/plain", "/home/ada/project/input.tsv");
    const getPathForFile = vi.fn();
    attachFilePathDrop(input, getPathForFile, vi.fn());

    const event = drop(input, dataTransfer);

    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe('"/home/ada/project/input.tsv"');
    expect(getPathForFile).not.toHaveBeenCalled();
  });

  it("makes Files pane rows draggable with an absolute Linux path", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    Object.defineProperty(window, "orbit", {
      configurable: true,
      value: {
        listFiles: async () => ({
          ok: true,
          cwd: "/home/ada/project",
          root: {
            name: "project",
            relPath: "",
            type: "directory",
            children: [{ name: "R 1.fastq", relPath: "reads/R 1.fastq", type: "file" }],
          },
        }),
      },
    });
    const panel = new FilesPanel(container, vi.fn());
    await panel.refresh();
    const row = container.querySelector<HTMLElement>(".files-tree-node[data-type='file']")!;
    const dataTransfer = new DataTransfer();
    const event = new Event("dragstart", { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });

    row.dispatchEvent(event);

    expect(row.draggable).toBe(true);
    expect(dataTransfer.getData(ORBIT_FILE_PATH_TYPE)).toBe("/home/ada/project/reads/R 1.fastq");
    expect(dataTransfer.getData("text/plain")).toBe("/home/ada/project/reads/R 1.fastq");
  });

  it("reports synthetic files with no local path instead of inserting a misleading name", () => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(["contents"], "input.tsv"));
    const onUnavailable = vi.fn();
    attachFilePathDrop(input, () => "", onUnavailable);

    drop(input, dataTransfer);

    expect(input.value).toBe("");
    expect(onUnavailable).toHaveBeenCalledOnce();
  });
});
