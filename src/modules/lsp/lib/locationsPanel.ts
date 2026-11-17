import { StateEffect, StateField } from "@codemirror/state";
import { type EditorView, type Panel, showPanel } from "@codemirror/view";
import {
  formatReferenceItemLabel,
  toggleReferenceGroup,
  visibleReferenceRows,
  type ReferenceLocationInput,
  type ReferenceTree,
  type ReferenceTreeRow,
} from "./referenceTree";

export type LocationItem = {
  uri: string;
  /** 0-based */
  line: number;
  character: number;
  label: string;
};

type PanelSpec = {
  title: string;
  items: LocationItem[];
  onPick: (item: LocationItem) => void;
};

const setLocationList = StateEffect.define<PanelSpec | null>();

const locationsField = StateField.define<PanelSpec | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setLocationList)) return e.value;
    }
    return value;
  },
  provide: (f) =>
    showPanel.from(f, (spec) =>
      spec ? (view) => createPanel(view, spec) : null,
    ),
});

export function openLocationsPanel(view: EditorView, spec: PanelSpec): void {
  view.dispatch({ effects: setLocationList.of(spec) });
}

function closePanel(view: EditorView): void {
  view.dispatch({ effects: setLocationList.of(null) });
  view.focus();
}

function createPanel(view: EditorView, spec: PanelSpec): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-lsp-locations";

  const header = document.createElement("div");
  header.className = "cm-lsp-locations-header";
  header.textContent = `${spec.title} (${spec.items.length})`;
  dom.appendChild(header);

  const list = document.createElement("ul");
  list.tabIndex = 0;
  dom.appendChild(list);

  let active = 0;
  const rows: HTMLElement[] = spec.items.map((item, i) => {
    const li = document.createElement("li");
    li.textContent = item.label;
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pick(i);
    });
    list.appendChild(li);
    return li;
  });

  const renderActive = () => {
    rows.forEach((row, i) => {
      row.classList.toggle("cm-lsp-locations-active", i === active);
    });
    rows[active]?.scrollIntoView({ block: "nearest" });
  };

  const pick = (i: number) => {
    const item = spec.items[i];
    closePanel(view);
    spec.onPick(item);
  };

  list.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      active = Math.min(active + 1, spec.items.length - 1);
      renderActive();
    } else if (e.key === "ArrowUp") {
      active = Math.max(active - 1, 0);
      renderActive();
    } else if (e.key === "Enter") {
      pick(active);
    } else if (e.key === "Escape") {
      closePanel(view);
    } else {
      return;
    }
    e.preventDefault();
  });

  renderActive();
  return {
    dom,
    mount: () => list.focus(),
  };
}

export const locationsPanel = locationsField;

// --- Fase 24: references tree panel (VS Code style) -----------------------
// Same bottom-panel slot as the flat list, but grouped by file with a
// count badge per group and the source-line preview per row. It has its
// own StateField so the flat definitions panel above stays untouched.

export type ReferenceTreePanelSpec = {
  title: string;
  tree: ReferenceTree;
  rootPath: string;
  onPick: (loc: ReferenceLocationInput) => void;
};

const setReferenceTree = StateEffect.define<ReferenceTreePanelSpec | null>();

const referenceTreeField = StateField.define<ReferenceTreePanelSpec | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setReferenceTree)) return e.value;
    }
    return value;
  },
  provide: (f) =>
    showPanel.from(f, (spec) =>
      spec ? (view) => createReferenceTreePanel(view, spec) : null,
    ),
});

export function openReferenceTreePanel(
  view: EditorView,
  spec: ReferenceTreePanelSpec,
): void {
  view.dispatch({ effects: setReferenceTree.of(spec) });
}

function closeReferenceTreePanel(view: EditorView): void {
  view.dispatch({ effects: setReferenceTree.of(null) });
  view.focus();
}

function createReferenceTreePanel(
  view: EditorView,
  spec: ReferenceTreePanelSpec,
): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-lsp-references";

  const header = document.createElement("div");
  header.className = "cm-lsp-references-header";
  header.textContent = `${spec.title} (${spec.tree.total})`;
  dom.appendChild(header);

  const list = document.createElement("ul");
  list.tabIndex = 0;
  dom.appendChild(list);

  // Mutable tree state lives in this closure; toggling a group only
  // re-renders the list, it never touches the StateField again.
  let tree = spec.tree;
  let active = 0;

  const render = () => {
    const rows = visibleReferenceRows(tree);
    if (active >= rows.length) active = Math.max(0, rows.length - 1);
    list.replaceChildren();
    rows.forEach((row, i) => {
      const li = document.createElement("li");
      if (row.kind === "group") {
        li.className = "cm-lsp-references-group";
        const chevron = document.createElement("span");
        chevron.className = "cm-lsp-references-chevron";
        chevron.textContent = row.collapsed ? "▸" : "▾";
        li.appendChild(chevron);
        const name = document.createElement("span");
        name.className = "cm-lsp-references-file";
        const rel = row.label;
        const slash = rel.lastIndexOf("/");
        name.textContent = slash === -1 ? rel : rel.slice(slash + 1);
        li.appendChild(name);
        if (slash !== -1) {
          const dir = document.createElement("span");
          dir.className = "cm-lsp-references-dir";
          dir.textContent = rel.slice(0, slash + 1);
          li.appendChild(dir);
        }
        const count = document.createElement("span");
        count.className = "cm-lsp-references-count";
        count.textContent = String(row.count);
        li.appendChild(count);
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();
          tree = toggleReferenceGroup(tree, row.groupUri);
          render();
        });
      } else {
        li.className = "cm-lsp-references-item";
        const preview = document.createElement("span");
        preview.className = "cm-lsp-references-preview";
        preview.textContent = formatReferenceItemLabel(
          row.loc,
          spec.rootPath,
        );
        li.appendChild(preview);
        const lineNo = document.createElement("span");
        lineNo.className = "cm-lsp-references-line";
        lineNo.textContent = `:${row.loc.line + 1}`;
        li.appendChild(lineNo);
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();
          pick(row);
        });
      }
      li.classList.toggle("cm-lsp-references-active", i === active);
      list.appendChild(li);
    });
    list.children[active]?.scrollIntoView({ block: "nearest" });
  };

  const pick = (row: ReferenceTreeRow) => {
    if (row.kind !== "item") return;
    const loc = row.loc;
    closeReferenceTreePanel(view);
    spec.onPick(loc);
  };

  const toggleAt = (row: ReferenceTreeRow) => {
    if (row.kind !== "group") return;
    tree = toggleReferenceGroup(tree, row.groupUri);
    render();
  };

  list.addEventListener("keydown", (e) => {
    const rows = visibleReferenceRows(tree);
    const row = rows[active];
    if (e.key === "ArrowDown") {
      active = Math.min(active + 1, rows.length - 1);
      render();
    } else if (e.key === "ArrowUp") {
      active = Math.max(active - 1, 0);
      render();
    } else if (e.key === "Enter") {
      if (!row) return;
      if (row.kind === "group") toggleAt(row);
      else pick(row);
    } else if (e.key === "ArrowRight") {
      if (row?.kind === "group" && row.collapsed) toggleAt(row);
      else return;
    } else if (e.key === "ArrowLeft") {
      if (row?.kind === "group" && !row.collapsed) toggleAt(row);
      else if (row?.kind === "item") {
        tree = toggleReferenceGroup(tree, row.groupUri);
        active = rows.findIndex(
          (r) => r.kind === "group" && r.groupUri === row.groupUri,
        );
        render();
      } else return;
    } else if (e.key === "Escape") {
      closeReferenceTreePanel(view);
    } else {
      return;
    }
    e.preventDefault();
  });

  render();
  return {
    dom,
    mount: () => list.focus(),
  };
}

export const referenceTreePanel = referenceTreeField;
