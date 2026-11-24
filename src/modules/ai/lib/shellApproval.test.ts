import { describe, expect, it } from "vitest";
import { describeShellCommand } from "./shellApproval";

describe("describeShellCommand — risk labels", () => {
  it("labels read-only navigation as safe", () => {
    expect(describeShellCommand('cd "C:\\Users\\fania\\Documents"').risk).toBe(
      "safe",
    );
    expect(describeShellCommand("dir").risk).toBe("safe");
    expect(describeShellCommand("ls -la").risk).toBe("safe");
    expect(describeShellCommand("git status").risk).toBe("safe");
    expect(describeShellCommand("git log --oneline").risk).toBe("safe");
    expect(describeShellCommand("cat README.md").risk).toBe("safe");
    expect(describeShellCommand("pwd").risk).toBe("safe");
  });

  it("labels installs, network, and writes as caution", () => {
    expect(describeShellCommand("npm install").risk).toBe("caution");
    expect(describeShellCommand("pnpm add react").risk).toBe("caution");
    expect(describeShellCommand("git commit -m x").risk).toBe("caution");
    expect(describeShellCommand("git push").risk).toBe("caution");
    expect(describeShellCommand("curl https://example.com").risk).toBe(
      "caution",
    );
    expect(describeShellCommand("mkdir new-folder").risk).toBe("caution");
    expect(describeShellCommand("cp a.txt b.txt").risk).toBe("caution");
    expect(describeShellCommand("npm run build").risk).toBe("caution");
  });

  it("labels deletes and moves as dangerous", () => {
    expect(describeShellCommand("rm -rf dist").risk).toBe("dangerous");
    expect(describeShellCommand("rm -rf /").risk).toBe("dangerous");
    expect(describeShellCommand("del file.txt").risk).toBe("dangerous");
    expect(describeShellCommand("Remove-Item -Recurse folder").risk).toBe(
      "dangerous",
    );
    expect(describeShellCommand("mv a.txt b.txt").risk).toBe("dangerous");
    expect(describeShellCommand("git reset --hard").risk).toBe("dangerous");
    expect(describeShellCommand("git clean -fdx").risk).toBe("dangerous");
  });

  it("labels unknown commands as caution, never safe", () => {
    expect(describeShellCommand("frobnicate --warp").risk).toBe("caution");
    expect(describeShellCommand("").risk).toBe("caution");
  });

  it("takes the highest risk across chained segments", () => {
    expect(describeShellCommand("cd src && npm install").risk).toBe("caution");
    expect(describeShellCommand("ls && rm -rf dist").risk).toBe("dangerous");
  });
});

describe("describeShellCommand — explanations", () => {
  it("explains cd with its target", () => {
    const info = describeShellCommand('cd "C:\\Users\\fania\\Documents"');
    expect(info.explanation).toContain("Pindah ke folder");
    expect(info.explanation).toContain("C:\\Users\\fania\\Documents");
    expect(info.explanation).toContain("Tidak mengubah");
  });

  it("explains npm install as installing packages", () => {
    const info = describeShellCommand("npm install");
    expect(info.explanation).toContain("memasang package");
  });

  it("explains a delete with its targets and no checkpoint", () => {
    const info = describeShellCommand("rm -rf dist node_modules");
    expect(info.explanation).toContain("Menghapus");
    expect(info.explanation).toContain("dist");
    expect(info.explanation).toContain("tidak bisa di-Restore");
  });

  it("explains chained commands as numbered steps", () => {
    const info = describeShellCommand("cd src && npm install && npm test");
    expect(info.explanation).toContain("3 langkah berurutan");
    expect(info.segments).toHaveLength(3);
  });

  it("does not split on && inside quotes", () => {
    const info = describeShellCommand('echo "a && b"');
    expect(info.segments).toHaveLength(1);
    expect(info.risk).toBe("safe");
  });
});

describe("describeShellCommand — touched paths", () => {
  it("lists delete targets", () => {
    expect(describeShellCommand("rm -rf dist").touchedPaths).toEqual([
      "dist",
    ]);
  });

  it("lists the cd target", () => {
    expect(describeShellCommand("cd src/components").touchedPaths).toEqual([
      "src/components",
    ]);
  });

  it("lists redirect targets", () => {
    expect(
      describeShellCommand("echo hello > out.txt").touchedPaths,
    ).toEqual(["out.txt"]);
  });

  it("lists copy operands", () => {
    expect(describeShellCommand("cp a.txt b.txt").touchedPaths).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  it("returns no touched paths for pure reads", () => {
    expect(describeShellCommand("git status").touchedPaths).toEqual([]);
    expect(describeShellCommand("ls").touchedPaths).toEqual([]);
  });
});
