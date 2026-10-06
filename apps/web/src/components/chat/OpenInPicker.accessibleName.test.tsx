// @vitest-environment jsdom

import { EnvironmentId, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const pickerState = vi.hoisted(() => ({
  editor: "vscode" as "vscode" | null,
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ label: "dev" }),
}));

vi.mock("../../editorPreferences", () => ({
  usePreferredEditor: () => [pickerState.editor, vi.fn()] as const,
}));

vi.mock("../../remoteOpen", () => ({
  openRemoteEditorUrl: vi.fn(async () => true),
  useRemoteCapableEditors: () => ["vscode"] as const,
  useRemoteOpenHint: () => [true, vi.fn()] as const,
  useRemoteOpenState: () => ({ mode: "local-exec" as const }),
}));

vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));

import { OpenInPicker } from "./OpenInPicker";

const keybindings = [] as ResolvedKeybindingsConfig;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  pickerState.editor = "vscode";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderPicker(
  props: { readonly compact?: boolean; readonly displayMode?: "toolbar" | "panel" } = {},
) {
  act(() => {
    root.render(
      <OpenInPicker
        environmentId={EnvironmentId.make("env-1")}
        keybindings={keybindings}
        availableEditors={pickerState.editor ? [pickerState.editor] : []}
        openInCwd="/tmp/repo"
        {...(props.compact === undefined ? {} : { compact: props.compact })}
        {...(props.displayMode === undefined ? {} : { displayMode: props.displayMode })}
      />,
    );
  });
}

/** The split button that opens the preferred editor, not the editor menu chevron. */
function openButton() {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes("Open"),
  );
  if (!button) throw new Error("Missing open-in-editor button");
  return button;
}

describe("OpenInPicker accessible name", () => {
  it("names the selected editor on the toolbar button", () => {
    renderPicker();

    expect(openButton().getAttribute("aria-label")).toBe("Open in VS Code");
    expect(openButton().textContent).toBe("Open");
    expect(container.querySelector('button[aria-label="Choose editor"]')).not.toBeNull();
  });

  it("names the selected editor on the compact file-preview button", () => {
    renderPicker({ compact: true });

    expect(openButton().getAttribute("aria-label")).toBe("Open in VS Code");
    expect(openButton().textContent).toBe("Open");
  });

  it("keeps the panel label as both the visible text and the accessible name", () => {
    renderPicker({ displayMode: "panel" });

    expect(openButton().getAttribute("aria-label")).toBe("Open in VS Code");
    expect(openButton().textContent).toBe("Open in VS Code");
  });

  it("keeps the generic labels when no editor is selected", () => {
    pickerState.editor = null;
    renderPicker();
    expect(openButton().getAttribute("aria-label")).toBe("Open");

    renderPicker({ compact: true });
    expect(openButton().getAttribute("aria-label")).toBe("Open file in preferred editor");
  });
});
