import { EditorState } from "@codemirror/state";
import {
  languageServerWithTransport,
  SynchronizationMethod,
  type LanguageServerClient,
  type Transport,
} from "codemirror-languageserver";
import { describe, expect, it } from "vitest";
import {
  changeSetToLspEvents,
  DocumentSyncTracker,
  lspDocumentSyncExtension,
  offsetToLspPosition,
  resolveLspSyncKind,
} from "./lspDocumentSync";
import { stripLspAutocompletion } from "./lspAutocompletion";
import type { TeraxLspClient } from "./client";

/** Minimal stub client: the sync plugin only calls didOpen/didChange
 * (and reads ready/capabilities/initializePromise), so a recording
 * stub is enough. The ViewPlugin itself is never instantiated in
 * these tests (no DOM env in the repo), only its extension is. */
function stubClient(): TeraxLspClient {
  return {
    ready: true,
    capabilities: {},
    initializePromise: Promise.resolve(),
    textDocumentDidOpen: async () => {},
    textDocumentDidChange: async () => {},
  } as unknown as TeraxLspClient;
}

describe("offsetToLspPosition", () => {
  it("maps offsets to 0-based line/character", () => {
    const doc = EditorState.create({ doc: "ab\ncdef\n" }).doc;
    expect(offsetToLspPosition(doc, 0)).toEqual({ line: 0, character: 0 });
    expect(offsetToLspPosition(doc, 2)).toEqual({ line: 0, character: 2 });
    expect(offsetToLspPosition(doc, 3)).toEqual({ line: 1, character: 0 });
    expect(offsetToLspPosition(doc, 7)).toEqual({ line: 1, character: 4 });
  });

  it("counts characters in UTF-16 units (astral chars are 2)", () => {
    // "a😀b": offsets are UTF-16 units, so the emoji occupies 2.
    const doc = EditorState.create({ doc: "a\u{1F600}b" }).doc;
    expect(offsetToLspPosition(doc, 3)).toEqual({ line: 0, character: 3 });
    expect(offsetToLspPosition(doc, 4)).toEqual({ line: 0, character: 4 });
  });
});

describe("changeSetToLspEvents", () => {
  it("maps a single insert to a zero-width range plus text", () => {
    const start = EditorState.create({ doc: "const x = 1;\n" });
    const tr = start.update({ changes: { from: 10, insert: "2" } });
    expect(changeSetToLspEvents(start.doc, tr.changes)).toEqual([
      {
        range: {
          start: { line: 0, character: 10 },
          end: { line: 0, character: 10 },
        },
        text: "2",
      },
    ]);
  });

  it("maps a delete to a range with empty text", () => {
    const start = EditorState.create({ doc: "abcdef\n" });
    const tr = start.update({ changes: { from: 2, to: 5 } });
    expect(changeSetToLspEvents(start.doc, tr.changes)).toEqual([
      {
        range: {
          start: { line: 0, character: 2 },
          end: { line: 0, character: 5 },
        },
        text: "",
      },
    ]);
  });

  it("maps a multi-line insert across lines", () => {
    const start = EditorState.create({ doc: "a\nb\n" });
    const tr = start.update({ changes: { from: 2, insert: "x\ny" } });
    expect(changeSetToLspEvents(start.doc, tr.changes)).toEqual([
      {
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 0 },
        },
        text: "x\ny",
      },
    ]);
  });

  it("sorts several changes in one transaction latest-offset first (mirror of the lib)", () => {
    const start = EditorState.create({ doc: "aaaa bbbb cccc\n" });
    const tr = start.update({
      changes: [
        { from: 0, to: 1, insert: "A" },
        { from: 5, to: 6, insert: "B" },
        { from: 10, to: 11, insert: "C" },
      ],
    });
    const events = changeSetToLspEvents(start.doc, tr.changes);
    expect(events.map((e) => e.text)).toEqual(["C", "B", "A"]);
    expect(events[0].range.start).toEqual({ line: 0, character: 10 });
    expect(events[2].range.start).toEqual({ line: 0, character: 0 });
  });

  it("returns no events for an empty changeset", () => {
    const start = EditorState.create({ doc: "abc\n" });
    const tr = start.update({});
    expect(changeSetToLspEvents(start.doc, tr.changes)).toEqual([]);
  });
});

describe("resolveLspSyncKind", () => {
  it("reads the server's declared textDocumentSync capability", () => {
    expect(resolveLspSyncKind({ textDocumentSync: 2 })).toBe("incremental");
    expect(resolveLspSyncKind({ textDocumentSync: 1 })).toBe("full");
    expect(resolveLspSyncKind({ textDocumentSync: { change: 2 } })).toBe(
      "incremental",
    );
    expect(resolveLspSyncKind({ textDocumentSync: { change: 1 } })).toBe(
      "full",
    );
    expect(
      resolveLspSyncKind({ textDocumentSync: { openClose: true } }),
    ).toBe("incremental");
  });

  it("defaults to incremental when the capability is missing", () => {
    expect(resolveLspSyncKind({})).toBe("incremental");
    expect(resolveLspSyncKind(undefined)).toBe("incremental");
    expect(resolveLspSyncKind(null)).toBe("incremental");
  });
});

describe("DocumentSyncTracker", () => {
  it("returns null for changes before the document is opened", () => {
    const tracker = new DocumentSyncTracker();
    expect(
      tracker.changeParams("file:///f.ts", [], "text", "incremental"),
    ).toBeNull();
  });

  it("opens at version 0, then versions didChange 0, 1, 2 (post-increment, mirror of the lib)", () => {
    const tracker = new DocumentSyncTracker();
    expect(tracker.openParams("file:///f.ts", "typescript", "const x = 1;"))
      .toEqual({
        textDocument: {
          uri: "file:///f.ts",
          languageId: "typescript",
          version: 0,
          text: "const x = 1;",
        },
      });
    const events = [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        text: "y",
      },
    ];
    expect(
      tracker.changeParams("file:///f.ts", events, "yconst x = 1;", "incremental"),
    ).toEqual({
      textDocument: { uri: "file:///f.ts", version: 0 },
      contentChanges: events,
    });
    expect(
      tracker.changeParams("file:///f.ts", events, "yyconst x = 1;", "incremental"),
    ).toEqual({
      textDocument: { uri: "file:///f.ts", version: 1 },
      contentChanges: events,
    });
    expect(
      tracker.changeParams("file:///f.ts", events, "yyyconst x = 1;", "incremental"),
    ).toEqual({
      textDocument: { uri: "file:///f.ts", version: 2 },
      contentChanges: events,
    });
  });

  it("sends the full text without a range for full sync", () => {
    const tracker = new DocumentSyncTracker();
    tracker.openParams("file:///f.ts", "typescript", "a");
    expect(
      tracker.changeParams("file:///f.ts", [], "abc", "full"),
    ).toEqual({
      textDocument: { uri: "file:///f.ts", version: 0 },
      contentChanges: [{ text: "abc" }],
    });
  });
});

describe("lspDocumentSyncExtension", () => {
  it("builds a valid extension that coexists with two preset sets in one state", () => {
    const client = stubClient();
    const syncExt = lspDocumentSyncExtension({
      client,
      documentUri: "file:///proj/file.tsx",
      languageId: "typescript",
    });
    const presetExtensions = () => {
      const libClient = { capabilities: {} } as unknown as LanguageServerClient;
      const transport = {} as unknown as Transport;
      return languageServerWithTransport({
        client: libClient,
        transport,
        rootUri: "file:///proj",
        workspaceFolders: [{ uri: "file:///proj", name: "proj" }],
        documentUri: "file:///proj/file.tsx",
        languageId: "typescript",
        allowHTMLContent: false,
        synchronizationMethod: SynchronizationMethod.Incremental,
      });
    };
    // First preset keeps its library plugin, second preset is stripped
    // (Fase 16) and gains the manual sync extension (Fase 17): the
    // combination must not throw at state creation / reconfigure.
    expect(() =>
      EditorState.create({
        doc: "const x = 1;\n",
        extensions: [
          presetExtensions(),
          stripLspAutocompletion(presetExtensions()),
          syncExt,
        ],
      }).update({}),
    ).not.toThrow();
  });
});
