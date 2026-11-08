import { describe, expect, it } from "vitest";
import {
  detectEol,
  diskTextMatchesBuffer,
  normalizeToLf,
  restoreEol,
} from "./eol";

describe("detectEol", () => {
  it("detects LF", () => {
    expect(detectEol("a\nb\nc")).toBe("\n");
  });

  it("detects CRLF", () => {
    expect(detectEol("a\r\nb\r\nc")).toBe("\r\n");
  });

  it("majority wins on mixed endings", () => {
    expect(detectEol("a\r\nb\r\nc\nd")).toBe("\r\n");
    expect(detectEol("a\nb\nc\r\nd")).toBe("\n");
  });

  it("defaults to LF for single-line content", () => {
    expect(detectEol("no line breaks")).toBe("\n");
    expect(detectEol("")).toBe("\n");
  });

  it("ties resolve to LF", () => {
    expect(detectEol("a\r\nb\nc")).toBe("\n");
  });
});

describe("normalizeToLf", () => {
  it("converts CRLF and lone CR", () => {
    expect(normalizeToLf("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("returns the same string when no CR present", () => {
    const s = "a\nb";
    expect(normalizeToLf(s)).toBe(s);
  });
});

describe("restoreEol", () => {
  it("round-trips CRLF content", () => {
    const original = "a\r\nb\r\nc";
    const eol = detectEol(original);
    expect(restoreEol(normalizeToLf(original), eol)).toBe(original);
  });

  it("leaves LF content untouched", () => {
    expect(restoreEol("a\nb", "\n")).toBe("a\nb");
  });
});

describe("diskTextMatchesBuffer", () => {
  // A saved CRLF file matches its LF buffer: this is the ESLint
  // dirty check. Comparing raw bytes here skipped every CRLF file
  // forever, so no diagnostics ever appeared for them.
  it("matches a saved CRLF file against its LF buffer", () => {
    const disk = "const a = 1;\r\nconst b = 2;\r\n";
    const buffer = "const a = 1;\nconst b = 2;\n";
    expect(diskTextMatchesBuffer(disk, buffer)).toBe(true);
  });

  it("matches a realistic CRLF TSX file against its LF buffer", () => {
    const disk =
      "const cvReport = useMemo(\r\n" +
      "  () =>\r\n" +
      "    cvResult\r\n" +
      "      ? null // buildCvScreeningReport dinonaktifkan sementara\r\n" +
      "      : null,\r\n" +
      "  [cvResult],\r\n" +
      ");\r\n";
    const buffer = normalizeToLf(disk);
    expect(diskTextMatchesBuffer(disk, buffer)).toBe(true);
  });

  it("still reports a genuinely dirty buffer", () => {
    const disk = "const a = 1;\r\nconst b = 2;\r\n";
    const buffer = "const a = 1;\nconst b = 3;\n";
    expect(diskTextMatchesBuffer(disk, buffer)).toBe(false);
  });

  it("still reports a genuinely dirty buffer when only a line is added", () => {
    const disk = "const a = 1;\r\nconst b = 2;\r\n";
    const buffer = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    expect(diskTextMatchesBuffer(disk, buffer)).toBe(false);
  });

  it("matches LF files (no regression)", () => {
    expect(diskTextMatchesBuffer("a\nb\n", "a\nb\n")).toBe(true);
    expect(diskTextMatchesBuffer("a\nb\n", "a\nc\n")).toBe(false);
  });

  it("matches an empty file", () => {
    expect(diskTextMatchesBuffer("", "")).toBe(true);
  });

  it("treats lone CR the same way the buffer does", () => {
    expect(diskTextMatchesBuffer("a\rb\r", "a\nb\n")).toBe(true);
  });
});
