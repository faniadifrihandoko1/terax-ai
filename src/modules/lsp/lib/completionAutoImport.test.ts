import { EditorState } from "@codemirror/state";
import type { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { languageServerPlugin } from "codemirror-languageserver";
import { describe, expect, it } from "vitest";

/**
 * Fase 29 (TDD): auto-import completion must write the import.
 *
 * Proven against the real typescript-language-server (fixture +
 * harness): the list item for `useGetModulePosition` carries NO
 * additionalTextEdits — the import edit only appears after
 * completionItem/resolve. The library's apply() used the unresolved
 * item, so accepting the completion inserted only the name.
 *
 * These tests drive the library's completion source through the
 * plugin factory with a fake client, so the resolve-on-accept
 * behaviour is covered without a DOM env (no EditorView needed:
 * the plugin constructor only reads view.state.doc, and apply only
 * needs view.state + view.dispatch).
 */

const DOC =
  "const { data } = useGetModulePosition({\n  job_id: '',\n  limit: 0,\n});\n";
const WORD = "useGetModulePosition";
const WORD_START = DOC.indexOf(WORD);
const CURSOR = WORD_START + WORD.length;

const IMPORT_EDIT = {
  range: {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  },
  newText: `import { ${WORD} } from "./hooks/query/module-position";\n\n`,
};

// The list item exactly as typescript-language-server returns it:
// label/detail/kind/data, no textEdit, no additionalTextEdits.
const LIST_ITEM = {
  label: WORD,
  kind: 3,
  detail: "./hooks/query/module-position",
  sortText: "0",
  data: { cacheId: 952 },
};

type FakeClient = {
  ready: boolean;
  capabilities: { completionProvider: { resolveProvider: boolean } };
  attachPlugin: () => void;
  textDocumentDidOpen: () => void;
  textDocumentCompletion: () => Promise<unknown>;
  completionItemResolve: (item: unknown) => Promise<unknown>;
};

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    ready: true,
    capabilities: { completionProvider: { resolveProvider: true } },
    attachPlugin: () => {},
    textDocumentDidOpen: () => {},
    textDocumentCompletion: async () => ({ items: [LIST_ITEM] }),
    completionItemResolve: async (item) => ({
      ...(item as Record<string, unknown>),
      additionalTextEdits: [IMPORT_EDIT],
    }),
    ...overrides,
  };
}

type RequestCompletionResult = {
  from: number;
  options: {
    label: string;
    apply: (
      view: unknown,
      completion: unknown,
      from: number,
      to: number,
    ) => unknown;
  }[];
};

async function acceptCompletion(client: FakeClient): Promise<string> {
  const state = EditorState.create({ doc: DOC });
  const dispatched: Transaction[] = [];
  const stubView = {
    state,
    dispatch: (tr: Transaction) => {
      dispatched.push(tr);
    },
  };
  // ViewPlugin.create is @internal (not in the .d.ts); the runtime
  // field exists (ViewPlugin constructor assigns it).
  const create = (
    languageServerPlugin as unknown as {
      create: (
        view: unknown,
        arg: unknown,
      ) => {
        requestCompletion: (
          context: unknown,
          pos: unknown,
          trigger: unknown,
        ) => Promise<RequestCompletionResult | null>;
      };
    }
  ).create;
  const plugin = create(stubView, {
    client,
    documentUri: "file:///consumer.tsx",
    languageId: "typescriptreact",
  });
  const context = {
    state,
    pos: CURSOR,
    explicit: true,
    matchBefore: () => ({ from: WORD_START, to: CURSOR, text: WORD }),
    view: stubView,
  };
  const result = await plugin.requestCompletion(
    context,
    { line: 0, character: CURSOR },
    { triggerKind: 1 },
  );
  expect(result).not.toBeNull();
  expect(result?.options).toHaveLength(1);
  const completion = result?.options[0];
  expect(completion?.label).toBe(WORD);
  await completion?.apply(
    stubView as unknown as EditorView,
    completion,
    result?.from ?? WORD_START,
    CURSOR,
  );
  expect(dispatched).toHaveLength(1);
  return dispatched[0].newDoc.toString();
}

describe("Fase 29: auto-import completion writes the import", () => {
  it("resolves the item on accept and applies the import edit", async () => {
    const doc = await acceptCompletion(makeClient());
    expect(doc).toBe(IMPORT_EDIT.newText + DOC);
  });

  it("falls back to the label when the server has no resolveProvider", async () => {
    const client = makeClient({
      capabilities: { completionProvider: { resolveProvider: false } },
      completionItemResolve: async () => {
        throw new Error("resolve must not be called");
      },
    });
    const doc = await acceptCompletion(client);
    expect(doc).toBe(DOC);
  });

  it("falls back to the label when resolve fails", async () => {
    const client = makeClient({
      completionItemResolve: async () => {
        throw new Error("server error");
      },
    });
    const doc = await acceptCompletion(client);
    expect(doc).toBe(DOC);
  });
});
