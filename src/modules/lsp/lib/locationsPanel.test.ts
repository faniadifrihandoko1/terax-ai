import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  closeLocationsPanel,
  closeReferenceTreePanel,
  locationsPanel,
  openLocationsPanel,
  openReferenceTreePanel,
  referenceTreePanel,
} from "./locationsPanel";
import { buildReferenceTree } from "./referenceTree";

// Fase 24.1 — the X button in the panel header calls the close helpers
// below; the DOM button itself cannot be tested (no DOM env in this
// repo), so these tests lock the seam the button drives: the close
// effect must clear the panel field, and closing must return focus to
// the editor. The open helpers are exercised the same way so the
// round-trip (open -> close -> null field) is proven, not assumed.

function stubView() {
  const dispatched: TransactionSpec[] = [];
  let focused = 0;
  const view = {
    dispatch: (tr: TransactionSpec) => {
      dispatched.push(tr);
    },
    focus: () => {
      focused += 1;
    },
  };
  return {
    view: view as unknown as EditorView,
    dispatched,
    get focused() {
      return focused;
    },
  };
}

describe("closeLocationsPanel", () => {
  it("clears the flat panel field and returns focus to the editor", () => {
    const stub = stubView();
    let state = EditorState.create({ extensions: [locationsPanel] });
    expect(state.field(locationsPanel)).toBeNull();

    openLocationsPanel(stub.view, {
      title: "Definitions",
      items: [
        {
          uri: "file:///C:/project/src/a.ts",
          line: 3,
          character: 2,
          label: "src/a.ts:4",
        },
      ],
      onPick: () => {},
    });
    state = state.update(stub.dispatched[0]).state;
    expect(state.field(locationsPanel)).not.toBeNull();

    closeLocationsPanel(stub.view);
    state = state.update(stub.dispatched[1]).state;
    expect(state.field(locationsPanel)).toBeNull();
    expect(stub.focused).toBe(1);
  });

  it("closing an already-closed panel stays null and does not throw", () => {
    const stub = stubView();
    const state = EditorState.create({ extensions: [locationsPanel] });
    expect(() => closeLocationsPanel(stub.view)).not.toThrow();
    const next = state.update(stub.dispatched[0]).state;
    expect(next.field(locationsPanel)).toBeNull();
  });
});

describe("closeReferenceTreePanel", () => {
  it("clears the tree panel field and returns focus to the editor", () => {
    const stub = stubView();
    let state = EditorState.create({ extensions: [referenceTreePanel] });
    expect(state.field(referenceTreePanel)).toBeNull();

    openReferenceTreePanel(stub.view, {
      title: "References",
      tree: buildReferenceTree(
        "References",
        [
          {
            uri: "file:///C:/project/src/a.ts",
            line: 0,
            character: 9,
            preview: 'import { Foo } from "./b";',
          },
          {
            uri: "file:///C:/project/src/b.ts",
            line: 5,
            character: 13,
            preview: "export const Foo = () => {};",
          },
        ],
        "C:/project",
      ),
      rootPath: "C:/project",
      onPick: () => {},
    });
    state = state.update(stub.dispatched[0]).state;
    expect(state.field(referenceTreePanel)).not.toBeNull();

    closeReferenceTreePanel(stub.view);
    state = state.update(stub.dispatched[1]).state;
    expect(state.field(referenceTreePanel)).toBeNull();
    expect(stub.focused).toBe(1);
  });

  it("closing an already-closed tree panel stays null and does not throw", () => {
    const stub = stubView();
    const state = EditorState.create({ extensions: [referenceTreePanel] });
    expect(() => closeReferenceTreePanel(stub.view)).not.toThrow();
    const next = state.update(stub.dispatched[0]).state;
    expect(next.field(referenceTreePanel)).toBeNull();
  });
});
