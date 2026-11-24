/**
 * Plain-language risk assessment for shell commands shown on the
 * approval card (Fase 38, DEL-138).
 *
 * Pure functions only: given a command string, classify its risk,
 * explain it in one or two Indonesian sentences, split it into its
 * chained steps, and list the local paths it touches. No model AI
 * involved — everything is pattern matching over the command text.
 *
 * Best-effort by design, same caveat as the destructive detector in
 * security.ts: indirection the text cannot see (variables, pipes into
 * rm, backticks) is missed, and the full command shown on the card
 * remains the backstop. Unknown commands are "caution", never "safe",
 * so an unfamiliar command can never look harmless.
 */

import {
  commandWord,
  detectDestructiveShellCommand,
  splitShellSegments,
  stripWrappers,
  tokenizeSegment,
} from "./security";

export type ShellRisk = "safe" | "caution" | "dangerous";

export type ShellApprovalInfo = {
  risk: ShellRisk;
  /** 1-2 kalimat Bahasa Indonesia. */
  explanation: string;
  /** Sub-perintah berantai, terurai (&&, ;, |). */
  segments: string[];
  /** Path lokal yang disentuh, dedup, maks 5. */
  touchedPaths: string[];
};

type SegmentInfo = {
  word: string;
  risk: ShellRisk;
  explanation: string;
  touched: string[];
};

const RISK_ORDER: Record<ShellRisk, number> = {
  safe: 0,
  caution: 1,
  dangerous: 2,
};

function maxRisk(a: ShellRisk, b: ShellRisk): ShellRisk {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

function shortTarget(t: string): string {
  return t.length > 48 ? `${t.slice(0, 48)}...` : t;
}

function joinTargets(targets: string[]): string {
  const shown = targets.slice(0, 3).map((t) => `"${shortTarget(t)}"`);
  const rest = targets.length - shown.length;
  return shown.join(", ") + (rest > 0 ? ` (+${rest} lainnya)` : "");
}

/** First non-flag operand after the command word. */
function firstOperand(tokens: string[]): string | null {
  for (const t of tokens.slice(1)) {
    if (t === "--") continue;
    if (t.startsWith("-") && t !== "-") continue;
    return t;
  }
  return null;
}

/** All non-flag operands after the command word. */
function operands(tokens: string[]): string[] {
  const out: string[] = [];
  let endOfFlags = false;
  for (const t of tokens.slice(1)) {
    if (!endOfFlags && t === "--") {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && t.startsWith("-") && t !== "-") continue;
    out.push(t);
  }
  return out;
}

/**
 * Redirect targets (`> file`, `>> file`, `2> file`) in one segment.
 * Best-effort: a `>` inside quotes is not a redirect, but this scan
 * does not track quotes, so a quoted `>` can yield a false target.
 * Targets are only displayed, never acted on, so a false positive
 * costs a confusing label, not a wrong decision.
 */
function redirectTargets(segment: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s\d])(>>?)\s*(["']?)([^\s"'|;&]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) {
    const target = m[3];
    if (target && target !== ">" && !target.startsWith(">")) {
      out.push(target.replace(/["']$/, ""));
    }
  }
  return out;
}

const GIT_READ_ONLY = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "remote",
  "ls-files",
  "rev-parse",
  "describe",
]);

const GIT_WRITE: Record<string, string> = {
  add: "Menandai file untuk di-commit ke git.",
  commit: "Menyimpan perubahan ke riwayat git (commit).",
  push: "Mengirim commit ke repositori remote.",
  pull: "Mengambil perubahan dari repositori remote dan menggabungkannya.",
  fetch: "Mengambil perubahan dari repositori remote tanpa menggabungkan.",
  merge: "Menggabungkan branch lain ke branch saat ini.",
  checkout:
    "Beralih ke branch atau commit lain. Bisa membuang perubahan yang belum disimpan pada file yang di-checkout.",
  stash: "Menyimpan perubahan sementara ke git stash.",
  clone: "Mengunduh salinan lengkap sebuah repositori.",
};

function describeGit(tokens: string[]): SegmentInfo {
  const sub = tokens[1] ?? "";
  if (sub === "clean" && tokens.slice(2).some((t) => t.includes("f"))) {
    return {
      word: "git",
      risk: "dangerous",
      explanation:
        "Menghapus file yang belum terlacak di git secara permanen. Tidak bisa di-Restore.",
      touched: [],
    };
  }
  if (sub === "reset" && tokens.includes("--hard")) {
    return {
      word: "git",
      risk: "dangerous",
      explanation:
        "Membuang semua perubahan yang belum di-commit. Tidak bisa di-Restore.",
      touched: [],
    };
  }
  if (GIT_READ_ONLY.has(sub)) {
    const what =
      sub === "status"
        ? "status git (file yang berubah dan belum di-commit)"
        : sub === "log"
          ? "riwayat commit git"
          : sub === "diff"
            ? "perbedaan file yang belum di-commit"
            : `informasi git (${sub})`;
    return {
      word: "git",
      risk: "safe",
      explanation: `Menampilkan ${what}. Tidak mengubah apa pun.`,
      touched: [],
    };
  }
  const write = GIT_WRITE[sub];
  if (write) {
    return { word: "git", risk: "caution", explanation: write, touched: [] };
  }
  return {
    word: "git",
    risk: "caution",
    explanation:
      "Menjalankan perintah git yang tidak dikenal oleh penilai risiko. Baca perintah lengkap di atas sebelum menyetujui.",
    touched: [],
  };
}

function describeSegment(segment: string): SegmentInfo {
  const tokens = tokenizeSegment(segment);
  const stripped = stripWrappers(tokens);
  if (stripped.length === 0) {
    return { word: "", risk: "safe", explanation: "", touched: [] };
  }
  const word = commandWord(stripped[0]);
  const rest = stripped.slice(1);

  // Destructive deletes/moves first: the detector already parsed the
  // targets, and any shell delete/move is dangerous by design (no
  // checkpoint, no Restore) even when the target is scoped.
  const destructive = detectDestructiveShellCommand(segment);
  if (destructive) {
    const targets = joinTargets(destructive.targets);
    const base =
      destructive.kind === "delete"
        ? `Menghapus ${targets}. File yang dihapus lewat terminal tidak punya checkpoint dan tidak bisa di-Restore.`
        : `Memindahkan ${targets}. File yang dipindah lewat terminal tidak punya checkpoint dan tidak bisa di-Restore.`;
    return {
      word,
      risk: "dangerous",
      explanation: destructive.catastrophic
        ? `Perintah ini akan ditolak saat dijalankan karena targetnya terlalu luas atau di lokasi sistem. ${base}`
        : base,
      touched: destructive.targets,
    };
  }

  const redirects = redirectTargets(segment);
  const writeViaRedirect = redirects.length > 0;

  switch (word) {
    case "cd":
    case "chdir": {
      const target = firstOperand(stripped) ?? "~";
      return {
        word,
        risk: "safe",
        explanation: `Pindah ke folder "${shortTarget(target)}". Tidak mengubah, menghapus, atau menginstall apa pun.`,
        touched: [target],
      };
    }
    case "pwd":
      return {
        word,
        risk: "safe",
        explanation:
          "Menampilkan folder kerja saat ini. Tidak mengubah apa pun.",
        touched: [],
      };
    case "dir":
    case "ls": {
      const target = firstOperand(stripped);
      return {
        word,
        risk: "safe",
        explanation: target
          ? `Menampilkan isi folder "${shortTarget(target)}". Tidak mengubah apa pun.`
          : "Menampilkan isi folder saat ini. Tidak mengubah apa pun.",
        touched: [],
      };
    }
    case "cat":
    case "type": {
      const files = operands(stripped);
      return {
        word,
        risk: "safe",
        explanation:
          files.length > 0
            ? `Menampilkan isi file ${joinTargets(files)}. Tidak mengubah apa pun.`
            : "Menampilkan isi file. Tidak mengubah apa pun.",
        touched: [],
      };
    }
    case "head":
    case "tail":
      return {
        word,
        risk: "safe",
        explanation:
          "Menampilkan sebagian isi file. Tidak mengubah apa pun.",
        touched: [],
      };
    case "echo": {
      if (writeViaRedirect) {
        return {
          word,
          risk: "caution",
          explanation: `Menulis teks ke file ${joinTargets(redirects)}.`,
          touched: redirects,
        };
      }
      return {
        word,
        risk: "safe",
        explanation: "Menampilkan teks ke terminal. Tidak mengubah apa pun.",
        touched: [],
      };
    }
    case "git":
      return describeGit(stripped);
    case "which":
    case "where":
    case "get-command": {
      const target = firstOperand(stripped);
      return {
        word,
        risk: "safe",
        explanation: target
          ? `Mencari lokasi perintah "${shortTarget(target)}". Tidak mengubah apa pun.`
          : "Mencari lokasi sebuah perintah. Tidak mengubah apa pun.",
        touched: [],
      };
    }
    case "grep":
    case "rg":
    case "find":
    case "select-string":
      return {
        word,
        risk: "safe",
        explanation: "Mencari file atau teks. Tidak mengubah apa pun.",
        touched: [],
      };
    case "tree":
      return {
        word,
        risk: "safe",
        explanation:
          "Menampilkan struktur folder. Tidak mengubah apa pun.",
        touched: [],
      };
    case "env":
    case "printenv":
      return {
        word,
        risk: "safe",
        explanation:
          "Menampilkan variabel environment. Tidak mengubah apa pun.",
        touched: [],
      };
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun": {
      const sub = rest[0] ?? "";
      if (sub === "run" || sub === "exec") {
        const script = rest[1] ?? "";
        return {
          word,
          risk: "caution",
          explanation: script
            ? `Menjalankan script "${shortTarget(script)}" dari package.json. Script bisa mengubah file proyek.`
            : "Menjalankan sebuah script proyek. Script bisa mengubah file proyek.",
          touched: [],
        };
      }
      if (sub === "dlx" || sub === "x") {
        return {
          word,
          risk: "caution",
          explanation:
            "Mengunduh dan menjalankan sebuah package tanpa memasang permanen.",
          touched: [],
        };
      }
      if (
        sub === "install" ||
        sub === "i" ||
        sub === "add" ||
        sub === "update"
      ) {
        return {
          word,
          risk: "caution",
          explanation:
            "Mengunduh dan memasang package ke proyek ini. Mengubah isi folder package dan lockfile.",
          touched: [],
        };
      }
      if (sub === "remove" || sub === "rm" || sub === "uninstall") {
        return {
          word,
          risk: "caution",
          explanation: "Menghapus package dari proyek ini.",
          touched: [],
        };
      }
      return {
        word,
        risk: "caution",
        explanation:
          "Menjalankan package manager. Baca perintah lengkap di atas sebelum menyetujui.",
        touched: [],
      };
    }
    case "npx":
      return {
        word,
        risk: "caution",
        explanation:
          "Mengunduh dan menjalankan sebuah package. Package yang dijalankan bisa mengubah file.",
        touched: [],
      };
    case "pip":
    case "pip3":
      return {
        word,
        risk: "caution",
        explanation:
          rest[0] === "uninstall"
            ? "Menghapus package Python dari environment ini."
            : "Mengunduh dan memasang package Python ke environment ini.",
        touched: [],
      };
    case "cargo":
      if (rest[0] === "add" || rest[0] === "install") {
        return {
          word,
          risk: "caution",
          explanation: "Menambah atau memasang crate Rust ke proyek ini.",
          touched: [],
        };
      }
      return {
        word,
        risk: "caution",
        explanation:
          "Menjalankan Cargo (build, test, atau run). Prosesnya bisa mengubah file proyek.",
        touched: [],
      };
    case "go":
      if (rest[0] === "get" || rest[0] === "install") {
        return {
          word,
          risk: "caution",
          explanation: "Mengunduh dan memasang package Go.",
          touched: [],
        };
      }
      return {
        word,
        risk: "caution",
        explanation:
          "Menjalankan Go (build, test, atau run). Prosesnya bisa mengubah file proyek.",
        touched: [],
      };
    case "brew":
    case "apt":
    case "apt-get":
    case "choco":
    case "winget":
      return {
        word,
        risk: "caution",
        explanation: "Menginstall atau mengubah software di sistem ini.",
        touched: [],
      };
    case "curl":
    case "wget":
    case "invoke-webrequest": {
      if (writeViaRedirect) {
        return {
          word,
          risk: "caution",
          explanation: `Mengunduh dari internet dan menulis ke file ${joinTargets(redirects)}.`,
          touched: redirects,
        };
      }
      return {
        word,
        risk: "caution",
        explanation: "Mengunduh data dari internet.",
        touched: [],
      };
    }
    case "ssh":
      return {
        word,
        risk: "caution",
        explanation: "Terhubung ke server lain lewat SSH.",
        touched: [],
      };
    case "scp":
      return {
        word,
        risk: "caution",
        explanation: "Menyalin file ke atau dari server lain.",
        touched: [],
      };
    case "cp":
    case "copy":
    case "copy-item":
    case "xcopy":
    case "robocopy": {
      const files = operands(stripped);
      return {
        word,
        risk: "caution",
        explanation:
          files.length > 0
            ? `Menyalin ${joinTargets(files)}.`
            : "Menyalin file atau folder.",
        touched: files,
      };
    }
    case "mkdir":
    case "md":
    case "new-item":
    case "touch": {
      const target = firstOperand(stripped);
      return {
        word,
        risk: "caution",
        explanation: target
          ? `Membuat ${word === "touch" ? "file" : "folder"} "${shortTarget(target)}".`
          : "Membuat file atau folder baru.",
        touched: target ? [target] : [],
      };
    }
    case "chmod":
    case "chown":
    case "icacls":
      return {
        word,
        risk: "caution",
        explanation: "Mengubah izin akses file atau folder.",
        touched: operands(stripped),
      };
    case "node":
    case "python":
    case "python3":
    case "pytest":
    case "vitest":
    case "jest":
      return {
        word,
        risk: "caution",
        explanation:
          "Menjalankan kode. Kode yang dijalankan bisa mengubah file.",
        touched: [],
      };
    case "docker":
      return {
        word,
        risk: "caution",
        explanation:
          "Membangun atau menjalankan container Docker. Bisa mengubah file dan memakai jaringan.",
        touched: [],
      };
    case "tee":
    case "set-content":
    case "out-file":
      return {
        word,
        risk: "caution",
        explanation:
          redirects.length > 0
            ? `Menulis output ke file ${joinTargets(redirects)}.`
            : "Menulis output ke file.",
        touched: redirects,
      };
    case "format":
    case "mkfs":
    case "fdisk":
    case "parted":
    case "diskutil":
      return {
        word,
        risk: "dangerous",
        explanation:
          "Memformat disk atau mengubah partisi. Data di dalamnya akan hilang permanen.",
        touched: [],
      };
    case "dd":
      return {
        word,
        risk: "dangerous",
        explanation:
          "Menulis langsung ke perangkat disk. Bisa menghapus seluruh isi disk.",
        touched: [],
      };
    case "reg": {
      const sub = rest[0] ?? "";
      if (sub === "delete") {
        return {
          word,
          risk: "dangerous",
          explanation:
            "Menghapus kunci registry Windows. Bisa merusak sistem atau aplikasi.",
          touched: [],
        };
      }
      return {
        word,
        risk: "caution",
        explanation: "Mengubah registry Windows.",
        touched: [],
      };
    }
    default: {
      if (writeViaRedirect) {
        return {
          word,
          risk: "caution",
          explanation: `Menulis output ke file ${joinTargets(redirects)}.`,
          touched: redirects,
        };
      }
      if (
        rest.includes("--version") ||
        rest.includes("-v") ||
        rest.includes("--help") ||
        rest.includes("-h")
      ) {
        return {
          word,
          risk: "safe",
          explanation: `Menampilkan versi atau bantuan perintah "${word}". Tidak mengubah apa pun.`,
          touched: [],
        };
      }
      return {
        word,
        risk: "caution",
        explanation: `Perintah "${word}" tidak dikenal oleh penilai risiko. Baca perintah lengkap di atas sebelum menyetujui.`,
        touched: [],
      };
    }
  }
}

export function describeShellCommand(command: string): ShellApprovalInfo {
  const raw = (command ?? "").trim();
  if (raw.length === 0) {
    return {
      risk: "caution",
      explanation: "Tidak ada perintah untuk dijalankan.",
      segments: [],
      touchedPaths: [],
    };
  }
  const segments = splitShellSegments(raw);
  const infos = segments.map(describeSegment).filter((s) => s.word !== "");
  if (infos.length === 0) {
    return {
      risk: "caution",
      explanation: "Tidak ada perintah untuk dijalankan.",
      segments,
      touchedPaths: [],
    };
  }
  const risk = infos.reduce<ShellRisk>(
    (acc, s) => maxRisk(acc, s.risk),
    "safe",
  );
  let explanation: string;
  if (infos.length === 1) {
    explanation = infos[0].explanation;
  } else {
    const shown = infos.slice(0, 3).map((s) => s.explanation);
    const rest = infos.length - shown.length;
    explanation =
      `Menjalankan ${infos.length} langkah berurutan. ` +
      shown.join(" ") +
      (rest > 0 ? ` (+${rest} langkah lagi, lihat daftar di bawah.)` : "");
  }
  const touched: string[] = [];
  for (const s of infos) {
    for (const t of s.touched) {
      if (!touched.includes(t)) touched.push(t);
    }
  }
  return {
    risk,
    explanation,
    segments,
    touchedPaths: touched.slice(0, 5),
  };
}
