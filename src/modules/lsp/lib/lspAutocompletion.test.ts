import { EditorState, type Extension, type StateField } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import {
  languageServerWithTransport,
  SynchronizationMethod,
  type LanguageServerClient,
  type Transport,
} from "codemirror-languageserver";
import { describe, expect, it } from "vitest";
import {
  LSP_AUTOCOMPLETION_INDEX,
  stripLspAutocompletion,
} from "./lspAutocompletion";

/**
 * One preset's extension set, exactly as `acquireForPreset` builds it:
 * `languageServerWithTransport` with stub client/transport. Building the
 * array performs no I/O — the client is only touched when a view
 * instantiates the plugin — so stubs are enough to exercise CodeMirror's
 * facet resolution, which is where the crash lives.
 */
function presetExtensions(): (Extension | StateField<string>)[] {
  const client = { capabilities: {} } as unknown as LanguageServerClient;
  const transport = {} as unknown as Transport;
  return languageServerWithTransport({
    client,
    transport,
    rootUri: "file:///proj",
    workspaceFolders: [{ uri: "file:///proj", name: "proj" }],
    documentUri: "file:///proj/file.tsx",
    languageId: "typescript",
    allowHTMLContent: false,
    synchronizationMethod: SynchronizationMethod.Incremental,
  });
}

/**
 * Builds a state from the given extension sets and applies one (empty)
 * transaction — the reconfigure path EditorStack dispatches, and the
 * exact path the reported crash took: facet resolution runs in
 * `CompletionState.update` when the transaction is applied.
 */
function applyTransaction(extensions: Extension[]): void {
  const state = EditorState.create({ doc: "const x = 1;\n", extensions });
  state.update({});
}

describe("two LSP presets in one editor (Fase 16)", () => {
  it("two full preset extension sets throw the reported error", () => {
    expect(() =>
      applyTransaction([presetExtensions(), presetExtensions()]),
    ).toThrow("Config merge conflict for field override");
  });

  it("one full set plus one stripped set does not throw", () => {
    expect(() =>
      applyTransaction([
        presetExtensions(),
        stripLspAutocompletion(presetExtensions()),
      ]),
    ).not.toThrow();
  });

  it("two stripped sets do not throw", () => {
    expect(() =>
      applyTransaction([
        stripLspAutocompletion(presetExtensions()),
        stripLspAutocompletion(presetExtensions()),
      ]),
    ).not.toThrow();
  });

  it("only dropping index 2 removes the conflict (layout pin for codemirror-languageserver 1.22.1)", () => {
    const first = presetExtensions();
    expect(first).toHaveLength(7);
    for (let i = 0; i < first.length; i++) {
      const second = presetExtensions().filter((_, j) => j !== i);
      if (i === LSP_AUTOCOMPLETION_INDEX) {
        expect(() => applyTransaction([first, second])).not.toThrow();
      } else {
        expect(() => applyTransaction([first, second])).toThrow(
          "Config merge conflict for field override",
        );
      }
    }
  });
});

describe("stripLspAutocompletion", () => {
  it("removes exactly one element and keeps the rest by reference, in order", () => {
    const full = presetExtensions();
    const stripped = stripLspAutocompletion(full);
    expect(stripped).toHaveLength(full.length - 1);
    expect(stripped).toEqual(
      full.filter((_, i) => i !== LSP_AUTOCOMPLETION_INDEX),
    );
  });

  it("passes a non-array extension through unchanged", () => {
    const single = keymap.of([]);
    expect(stripLspAutocompletion(single)).toBe(single);
  });
});
