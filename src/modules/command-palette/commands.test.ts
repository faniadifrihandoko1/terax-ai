import { describe, expect, it } from "vitest";
import type { Tab } from "@/modules/tabs";
import { useEslintStore } from "@/modules/eslint/lib/eslintStore";
import {
  type CommandPaletteActionContext,
  createCommandItems,
} from "./commands";

function terminalTab(id: number): Tab {
  return {
    id,
    kind: "terminal",
    spaceId: "s",
    title: "shell",
    paneTree: { kind: "leaf", id: id * 10 },
    activeLeafId: id * 10,
  } as unknown as Tab;
}

function baseContext(
  over: Partial<CommandPaletteActionContext> = {},
): CommandPaletteActionContext {
  const noop = () => {};
  return {
    tabs: [terminalTab(1)],
    activeId: 1,
    searchTarget: "content" as never,
    explorerRoot: "/workspace",
    home: "/home/me",
    spaces: [],
    activeSpaceId: null,
    activeFilePath: null,
    eslintEnabled: true,
    runEslintOnCurrentFile: noop,
    runEslintOnEntireProject: noop,
    fixEslintAtCursor: noop,
    fixAllEslint: noop,
    openNewTab: noop,
    openNewBlock: noop,
    openNewPrivate: noop,
    openNewEditor: noop,
    openNewPreview: noop,
    openGitGraph: noop,
    toggleSourceControl: noop,
    closeActiveTabOrPane: noop,
    splitPaneRight: noop,
    splitPaneDown: noop,
    focusSearch: noop,
    focusExplorerSearch: noop,
    toggleSidebar: noop,
    toggleHiddenFiles: noop,
    toggleAi: noop,
    askAiSelection: noop,
    openSettings: noop,
    openKeyboardShortcuts: noop,
    openSpacesOverview: noop,
    newSpace: noop,
    switchSpace: noop,
    ...over,
  };
}

function reasonById(over: Partial<CommandPaletteActionContext>, id: string) {
  const item = createCommandItems(baseContext(over)).find((i) => i.id === id);
  if (!item) throw new Error(`no command item ${id}`);
  return item.disabledReason;
}

describe("createCommandItems", () => {
  it("enables split on a terminal tab below the pane limit", () => {
    expect(reasonById({}, "pane.splitRight")).toBeUndefined();
    expect(reasonById({}, "pane.splitDown")).toBeUndefined();
  });

  it("disables split when there is no terminal tab", () => {
    const editorTab = { ...terminalTab(1), kind: "editor" } as unknown as Tab;
    expect(reasonById({ tabs: [editorTab] }, "pane.splitRight")).toBe(
      "No terminal tab",
    );
  });

  it("disables close on the last tab with a single pane", () => {
    expect(reasonById({}, "tab.close")).toBe("Last tab");
  });

  it("enables close when more than one tab is open", () => {
    expect(
      reasonById({ tabs: [terminalTab(1), terminalTab(2)] }, "tab.close"),
    ).toBeUndefined();
  });

  it("disables content search when there is no searchable view", () => {
    expect(reasonById({ searchTarget: null as never }, "search.focus")).toBe(
      "No searchable view",
    );
  });

  it("disables explorer search when there is no workspace root", () => {
    expect(reasonById({ explorerRoot: null }, "explorer.search")).toBe(
      "No workspace root",
    );
  });

  it("marks the active space as the current one", () => {
    const reason = reasonById(
      { spaces: [{ id: "sp1", name: "One" }], activeSpaceId: "sp1" },
      "spaces.switch.sp1",
    );
    expect(reason).toBe("Current space");
  });

  it("enables Run ESLint for a lintable active file", () => {
    expect(
      reasonById({ activeFilePath: "/proj/src/a.tsx" }, "eslint.run"),
    ).toBeUndefined();
  });

  it("disables Run ESLint when ESLint is off, no file is open, or the file is not lintable", () => {
    expect(
      reasonById(
        { activeFilePath: "/proj/src/a.tsx", eslintEnabled: false },
        "eslint.run",
      ),
    ).toBe("ESLint diagnostics off");
    expect(reasonById({ activeFilePath: null }, "eslint.run")).toBe(
      "No file open",
    );
    expect(
      reasonById({ activeFilePath: "/proj/src/a.py" }, "eslint.run"),
    ).toBe("Not a JavaScript/TypeScript file");
  });

  it("disables Run ESLint on review and diff tabs, with the real reason", () => {
    const aiDiffTab = { ...terminalTab(1), kind: "ai-diff" } as unknown as Tab;
    expect(
      reasonById({ tabs: [aiDiffTab], activeFilePath: null }, "eslint.run"),
    ).toBe("Buka file di tab editor, bukan tab review");
    const gitDiffTab = {
      ...terminalTab(1),
      kind: "git-diff",
    } as unknown as Tab;
    expect(
      reasonById(
        { tabs: [gitDiffTab], activeFilePath: "/proj/src/a.tsx" },
        "eslint.run",
      ),
    ).toBe("Buka file di tab editor, bukan tab diff");
    const gitCommitFileTab = {
      ...terminalTab(1),
      kind: "git-commit-file",
    } as unknown as Tab;
    expect(
      reasonById(
        { tabs: [gitCommitFileTab], activeFilePath: "/proj/src/a.tsx" },
        "eslint.run",
      ),
    ).toBe("Buka file di tab editor, bukan tab diff");
  });

  it("runs the manual ESLint command for the current file", () => {
    let ran = 0;
    const items = createCommandItems(
      baseContext({
        activeFilePath: "/proj/src/a.tsx",
        runEslintOnCurrentFile: () => {
          ran += 1;
        },
      }),
    );
    const item = items.find((i) => i.id === "eslint.run");
    expect(item).toBeDefined();
    expect(item?.group).toBe("Editor");
    item?.run();
    expect(ran).toBe(1);
  });

  it("disables the fix commands while the ESLint server is not active for the file", () => {
    useEslintStore.getState().setLspActive("/proj/src/a.tsx", false);
    expect(
      reasonById(
        { activeFilePath: "/proj/src/a.tsx" },
        "eslint.fix-at-cursor",
      ),
    ).toBe("ESLint server not active for this file");
    expect(
      reasonById({ activeFilePath: "/proj/src/a.tsx" }, "eslint.fix-all"),
    ).toBe("ESLint server not active for this file");
  });

  it("enables the fix commands when the ESLint server is active for the file", () => {
    const store = useEslintStore.getState();
    store.setLspActive("/proj/src/a.tsx", true);
    try {
      expect(
        reasonById(
          { activeFilePath: "/proj/src/a.tsx" },
          "eslint.fix-at-cursor",
        ),
      ).toBeUndefined();
      expect(
        reasonById({ activeFilePath: "/proj/src/a.tsx" }, "eslint.fix-all"),
      ).toBeUndefined();
    } finally {
      store.setLspActive("/proj/src/a.tsx", false);
    }
  });

  it("enables Run ESLint on entire project when a root is open", () => {
    expect(
      reasonById({ explorerRoot: "/proj" }, "eslint.run-project"),
    ).toBeUndefined();
    expect(
      reasonById(
        { explorerRoot: null, home: "/home/me" },
        "eslint.run-project",
      ),
    ).toBeUndefined();
  });

  it("disables the project-wide ESLint run without a root or when off", () => {
    expect(
      reasonById(
        { explorerRoot: null, home: null },
        "eslint.run-project",
      ),
    ).toBe("No project open");
    expect(
      reasonById({ explorerRoot: "/proj", eslintEnabled: false }, "eslint.run-project"),
    ).toBe("ESLint diagnostics off");
  });

  it("runs the project-wide ESLint command", () => {
    let ran = 0;
    const items = createCommandItems(
      baseContext({
        explorerRoot: "/proj",
        runEslintOnEntireProject: () => {
          ran += 1;
        },
      }),
    );
    const item = items.find((i) => i.id === "eslint.run-project");
    expect(item).toBeDefined();
    expect(item?.group).toBe("Editor");
    expect(item?.title).toBe("Run ESLint on entire project");
    item?.run();
    expect(ran).toBe(1);
  });
});
