import { describe, expect, it } from "vite-plus/test";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS, parseKeybindingShortcut } from "@t3tools/shared/keybindings";

import { installShortcutLayoutMap, resolveShortcutCommand } from "../../keybindings";
import {
  buildKeybindingRows,
  buildKeybindingCommandOptions,
  buildWhenVariableOptions,
  commandLabel,
  keybindingConflictLabels,
  keybindingFromKeyboardEvent,
  parseWhenExpressionDraft,
  shortcutToKeybindingInput,
  unknownWhenVariables,
  whenAstToExpression,
  whenNodeRemoveLabel,
} from "./KeybindingsSettings.logic";

const noModifiers = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

describe("KeybindingsSettings.logic", () => {
  it("lists composer, provider, and pull request commands with editable defaults", () => {
    const rows = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "");
    for (const command of [
      "composer.sendAlternate",
      "composer.sendBackground",
      "thread.steerQueuedMessage",
      "thread.editQueuedMessage",
      "composer.host",
      "composer.effort",
      "composer.mode",
      "composer.workspace",
      "composer.branch",
      "composer.previousWorktree",
      "modelPicker.previousProvider",
      "modelPicker.nextProvider",
      "thread.copyReference",
      "pullRequest.copyNumber",
    ]) {
      expect(rows.find((row) => row.command === command)).toMatchObject({
        source: "Default",
        conflicts: [],
      });
    }
  });
  it("finds the editable shortcut for sending the first queued message", () => {
    expect(buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "first queued")).toContainEqual(
      expect.objectContaining({
        command: "thread.steerQueuedMessage",
        key: "mod+shift+enter",
      }),
    );
  });
  it.each(["pu", "pull request", "copy link", "thread id"])(
    "finds the copy link shortcut with %s",
    (query) => {
      const rows = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, query);
      expect(rows).toContainEqual(
        expect.objectContaining({ command: "thread.copyReference", key: "mod+shift+c" }),
      );
    },
  );
  it("orders Usage bindings and command choices like the page", () => {
    const expected = [
      "usage.open",
      "usage.cost",
      "usage.tokens",
      "usage.limits",
      "usage.period.day",
      "usage.period.week",
      "usage.period.month",
      "usage.period.quarter",
    ];
    // The order must not depend on the order of the configured bindings.
    for (const bindings of [
      DEFAULT_RESOLVED_KEYBINDINGS,
      DEFAULT_RESOLVED_KEYBINDINGS.toReversed(),
    ]) {
      expect(buildKeybindingRows(bindings, "usage").map((row) => row.command)).toEqual(expected);
      expect(
        buildKeybindingCommandOptions(bindings).filter((command) => command.startsWith("usage.")),
      ).toEqual(expected);
    }
  });

  it("builds searchable rows with readable key and when values", () => {
    const rows = buildKeybindingRows(
      [
        {
          command: "terminal.toggle",
          shortcut: {
            key: "j",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
      ] satisfies ResolvedKeybindingsConfig,
      "terminal",
    );

    expect(rows).toEqual([
      expect.objectContaining({
        command: "terminal.toggle",
        key: "mod+j",
        when: "!terminalFocus",
        defaultKey: "mod+j",
        defaultWhen: "",
        source: "Custom",
      }),
    ]);
  });

  it("captures platform-specific mod shortcuts", () => {
    expect(
      keybindingFromKeyboardEvent(
        { key: "K", code: "KeyK", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
        "MacIntel",
      ),
    ).toBe("mod+shift+k");
    expect(
      keybindingFromKeyboardEvent(
        { key: "K", code: "KeyK", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        "Win32",
      ),
    ).toBe("mod+shift+k");
  });

  it.each([
    ["k", "KeyK", "k"],
    ["Tab", "Tab", "tab"],
    ["F5", "F5", "f5"],
  ])("captures %s without a modifier", (key, code, expected) => {
    const noModifiers = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(keybindingFromKeyboardEvent({ key, code, ...noModifiers }, "MacIntel")).toBe(expected);
  });

  it("waits for a key when only a modifier is pressed", () => {
    expect(
      keybindingFromKeyboardEvent(
        {
          key: "Meta",
          code: "MetaLeft",
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBeNull();
  });

  it.each([
    // US layout: the key's own name, so labels and conflicts match the defaults.
    ["@", "Digit2", "mod+shift+2"],
    ["{", "BracketLeft", "mod+shift+["],
    // Other layouts: the character typed, where the US name would be a different character.
    ['"', "Digit2", 'mod+shift+"'],
    ["@", "Quote", "mod+shift+@"],
    // German ISO: the key left of Return types # unshifted and ' with Shift.
    ["'", "Backslash", "mod+shift+'"],
  ])("captures shifted %s at %s", (key, code, expected) => {
    expect(
      keybindingFromKeyboardEvent(
        {
          key,
          code,
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: true,
        },
        "MacIntel",
      ),
    ).toBe(expected);
  });

  it.each([
    ["#", "Backslash", "mod+#"],
    ["ü", "BracketLeft", "mod+ü"],
    ["+", "BracketRight", "mod++"],
  ])("captures the unshifted layout character %s at %s", (key, code, expected) => {
    const input = keybindingFromKeyboardEvent(
      { ...noModifiers, key, code, metaKey: true },
      "MacIntel",
    );
    expect(input).toBe(expected);
    expect(parseKeybindingShortcut(input!)?.key).toBe(key);
  });

  it("fires a chord recorded on a German layout from the same key", () => {
    const pressed = {
      ...noModifiers,
      key: "#",
      code: "Backslash",
      metaKey: true,
    };
    const shortcut = parseKeybindingShortcut(keybindingFromKeyboardEvent(pressed, "MacIntel")!)!;
    expect(
      resolveShortcutCommand(pressed, [{ command: "chat.new", shortcut }], {
        platform: "MacIntel",
      }),
    ).toBe("chat.new");
  });

  it("fires Shift on the German # key from the character that press types", () => {
    const pressed = {
      key: "'",
      code: "Backslash",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    };
    const input = keybindingFromKeyboardEvent(pressed, "MacIntel");
    expect(input).toBe("mod+shift+'");
    const shortcut = parseKeybindingShortcut(input!)!;
    expect(
      resolveShortcutCommand(pressed, [{ command: "chat.new", shortcut }], {
        platform: "MacIntel",
      }),
    ).toBe("chat.new");
  });

  it("captures the key, not the Option symbol, on macOS", () => {
    expect(
      keybindingFromKeyboardEvent(
        {
          key: "“",
          code: "BracketLeft",
          metaKey: true,
          ctrlKey: false,
          altKey: true,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBe("mod+alt+[");
  });

  it("captures US key names for global shortcuts, which Electron names by position", () => {
    expect(
      keybindingFromKeyboardEvent(
        {
          ...noModifiers,
          key: "#",
          code: "Backslash",
          metaKey: true,
        },
        "MacIntel",
        { physicalKeys: true },
      ),
    ).toBe("mod+\\");
    expect(
      keybindingFromKeyboardEvent(
        {
          ...noModifiers,
          key: "z",
          code: "KeyY",
          metaKey: true,
        },
        "MacIntel",
        { physicalKeys: true },
      ),
    ).toBe("mod+y");
  });

  it("captures Latin layout keys instead of their punctuation position", () => {
    expect(
      keybindingFromKeyboardEvent(
        {
          key: "m",
          code: "Semicolon",
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBe("mod+m");
  });

  it("serializes shortcuts and when expressions for upserts", () => {
    expect(
      shortcutToKeybindingInput({
        key: " ",
        modKey: true,
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
      }),
    ).toBe("mod+alt+space");

    expect(
      whenAstToExpression({
        type: "and",
        left: { type: "identifier", name: "editorFocus" },
        right: {
          type: "not",
          node: { type: "identifier", name: "terminalFocus" },
        },
      }),
    ).toBe("editorFocus && !terminalFocus");

    expect(parseWhenExpressionDraft("editorFocus && (!terminalFocus || modelPickerOpen)")).toEqual({
      ok: true,
      value: {
        type: "and",
        left: { type: "identifier", name: "editorFocus" },
        right: {
          type: "or",
          left: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
          right: { type: "identifier", name: "modelPickerOpen" },
        },
      },
    });
    expect(parseWhenExpressionDraft("editorFocus &&")).toEqual({
      ok: false,
      message: "Use variables with !, &&, ||, and parentheses.",
    });

    expect(parseWhenExpressionDraft("!(terminalFocus || modelPickerOpen)")).toEqual({
      ok: true,
      value: {
        type: "not",
        node: {
          type: "or",
          left: { type: "identifier", name: "terminalFocus" },
          right: { type: "identifier", name: "modelPickerOpen" },
        },
      },
    });
  });

  it("describes the scope of each visual expression removal", () => {
    const condition = { type: "identifier", name: "terminalFocus" } as const;
    const negatedCondition = { type: "not", node: condition } as const;
    const group = { type: "and", left: condition, right: negatedCondition } as const;
    const negatedGroup = { type: "not", node: group } as const;

    expect(whenNodeRemoveLabel(group, 0)).toBe("Clear all conditions");
    expect(whenNodeRemoveLabel(condition, 1)).toBe("Remove condition");
    expect(whenNodeRemoveLabel(negatedCondition, 1)).toBe("Remove condition");
    expect(whenNodeRemoveLabel(group, 1)).toBe("Remove group and its conditions");
    expect(whenNodeRemoveLabel(negatedGroup, 1)).toBe("Remove group and its conditions");
  });

  it("formats static and project script command labels", () => {
    expect(commandLabel("commandPalette.toggle")).toBe("Command Palette: Toggle");
    expect(commandLabel("themeEditor.toggle")).toBe("Theme Editor: Toggle");
    expect(commandLabel("script.setup-db.run")).toBe("Run Script: Setup Db");
  });

  it("builds known when variable options from defaults without frontend labels", () => {
    const options = buildWhenVariableOptions();

    expect(options).toEqual(
      expect.arrayContaining([
        "terminalFocus",
        "terminalOpen",
        "isWeb",
        "isDesktop",
        "modelPickerOpen",
        "true",
        "false",
      ]),
    );
    expect(options).not.toContain("customModeActive");
  });

  it("builds command options from all static commands and resolved project bindings", () => {
    const options = buildKeybindingCommandOptions([
      {
        command: "script.setup-db.run",
        shortcut: {
          key: "r",
          modKey: true,
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
      },
    ] satisfies ResolvedKeybindingsConfig);

    expect(options).toEqual(
      expect.arrayContaining([
        "chat.new",
        "threadPanel.toggle",
        "rightPanel.toggleMaximized",
        "composer.cycleHost",
        "thread.stop",
        "usage.open",
        "script.setup-db.run",
      ]),
    );
    for (const command of ["thread.stop", "composer.cycleHost"]) {
      expect(DEFAULT_RESOLVED_KEYBINDINGS.some((binding) => binding.command === command)).toBe(
        false,
      );
    }
  });

  it("reports unknown when variables without rejecting parseable expressions", () => {
    const parsed = parseWhenExpressionDraft("!terminalFocus && terminalFoc");

    expect(parsed.ok).toBe(true);
    expect(unknownWhenVariables(parsed.ok ? parsed.value : undefined)).toEqual(["terminalFoc"]);
  });

  it("marks each default shortcut for multi-binding commands as default", () => {
    const rows = buildKeybindingRows(
      [
        {
          command: "chat.new",
          shortcut: {
            key: "n",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
        {
          command: "chat.new",
          shortcut: {
            key: "o",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: true,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
      ] satisfies ResolvedKeybindingsConfig,
      "",
    );

    expect(rows.map((row) => row.source)).toEqual(["Default", "Default"]);
  });

  it("reports conflicting shortcuts that share an active when context", () => {
    const rows = buildKeybindingRows(
      [
        {
          command: "chat.new",
          shortcut: {
            key: "n",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
        {
          command: "chat.newLocal",
          shortcut: {
            key: "n",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
      ] satisfies ResolvedKeybindingsConfig,
      "",
    );

    expect(rows[0]?.conflicts).toEqual(["Chat: New Local"]);
    expect(
      keybindingConflictLabels(rows, {
        rowId: rows[0]?.id ?? "",
        key: "mod+n",
        when: "",
      }),
    ).toEqual(["Chat: New Local"]);
  });

  it("treats a layout character and the US name of that key as one chord", () => {
    installShortcutLayoutMap({
      get(code) {
        if (code === "BracketLeft") return "ü";
        if (code === "BracketRight") return "+";
        if (code === "Semicolon") return "m";
        return undefined;
      },
    });
    try {
      const rows = buildKeybindingRows(
        [
          {
            command: "navigation.back",
            shortcut: {
              key: "[",
              modKey: true,
              metaKey: false,
              ctrlKey: false,
              altKey: false,
              shiftKey: false,
            },
          },
          {
            command: "chat.new",
            shortcut: {
              key: "ü",
              modKey: true,
              metaKey: false,
              ctrlKey: false,
              altKey: false,
              shiftKey: false,
            },
          },
          {
            command: "sidebar.toggle",
            shortcut: {
              key: ";",
              modKey: true,
              metaKey: false,
              ctrlKey: false,
              altKey: false,
              shiftKey: false,
            },
          },
          {
            command: "diff.toggle",
            shortcut: {
              key: "m",
              modKey: true,
              metaKey: false,
              ctrlKey: false,
              altKey: false,
              shiftKey: false,
            },
          },
        ] satisfies ResolvedKeybindingsConfig,
        "",
      );

      expect(rows.find((row) => row.command === "chat.new")?.conflicts).toEqual([
        "Navigation: Back",
      ]);
      expect(rows.find((row) => row.command === "navigation.back")?.conflicts).toEqual([
        "Chat: New",
      ]);
      expect(rows.find((row) => row.command === "diff.toggle")?.conflicts).toEqual([]);
      expect(
        keybindingConflictLabels(rows, {
          rowId: "new",
          key: "mod+shift+ü",
          when: "",
        }),
      ).toEqual([]);
    } finally {
      installShortcutLayoutMap(null);
    }
  });
});
