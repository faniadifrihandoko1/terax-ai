/**
 * Path-safety guards for AI tool calls.
 *
 * Goals:
 *  - Block reads of files that almost always contain secrets (.env*, *.pem,
 *    id_rsa*, .aws/credentials, .ssh/, .git/, kube/azure config, etc.).
 *  - Block writes/exec into the same set, plus directories where automated
 *    mutation is dangerous (system dirs, Windows system dirs).
 *
 * This is a *defense layer*, not a sandbox. The model may still be coaxed
 * into doing something silly within allowed paths — the user-confirmation
 * UI for write/exec is the real safety net. These checks ensure that
 * read tools (which auto-approve) can never silently exfiltrate obvious
 * secrets, and that a single bad approval can't blow up the system.
 *
 * Defense-in-depth notes:
 *  - Comparison surface is lowercased *only for matching*. Original path is
 *    preserved for basename pattern checks and error messages.
 *  - Windows drive prefix (e.g. `C:`) is stripped from the comparison form so
 *    Unix-style root prefix checks behave consistently on both platforms.
 *  - Protected directories match exact-equal-or-descendant, not raw
 *    substring-with-trailing-slash. Bare names (`/Users/me/.ssh`) and
 *    case-variants (`/Users/me/.SSH/config` on macOS/Windows case-insensitive
 *    filesystems) are caught.
 *  - The caller is expected to additionally validate the *canonical* path
 *    (post symlink resolution) via `native.canonicalize` + a second
 *    `checkReadable` pass, since a symlink at an "innocent" path can point
 *    into a protected directory.
 */

const SECRET_BASENAME_PATTERNS: RegExp[] = [
  // Match `.env` and `.env.<suffix>` with no required tail anchor — Windows
  // strips trailing dots/spaces at open time and NTFS exposes alternate data
  // streams via `name:stream`, both of which would otherwise slip past a `$`
  // anchored pattern (`.env.`, `.env::$DATA`).
  /^\.env(\..+)?(?:[.\s:]|$)/i,
  /^.*\.pem(?:[.\s:]|$)/i,
  /^.*\.key(?:[.\s:]|$)/i, // private keys
  /^.*\.p12(?:[.\s:]|$)/i,
  /^.*\.pfx(?:[.\s:]|$)/i,
  /^.*\.asc(?:[.\s:]|$)/i, // PGP armored keys
  /^.*\.gpg(?:[.\s:]|$)/i,
  /^.*\.keystore(?:[.\s:]|$)/i,
  /^.*\.jks(?:[.\s:]|$)/i,
  // Match `id_rsa`, `id_rsa.pub`, and common backup/copy patterns like
  // `id_rsa.bak`, `id_rsa_old`, `id_rsa-backup`.
  /^id_(rsa|dsa|ecdsa|ed25519)([._-].*)?(?:[.\s:]|$)/i,
  /^known_hosts(?:[.\s:]|$)/i,
  /^authorized_keys(?:[.\s:]|$)/i,
  /^htpasswd(?:[.\s:]|$)/i,
  /^\.netrc(?:[.\s:]|$)/i,
  /^_netrc(?:[.\s:]|$)/i, // Windows variant
  /^credentials(?:[.\s:]|$)/i, // .aws/credentials, gcloud, etc.
  /^\.pgpass(?:[.\s:]|$)/i,
  /^\.npmrc(?:[.\s:]|$)/i,
  /^\.pypirc(?:[.\s:]|$)/i,
  /^secrets?\.(json|ya?ml|toml|env)(?:[.\s:]|$)/i,
  /^service[-_]?account.*\.json(?:[.\s:]|$)/i, // GCP service account keys
];

/**
 * Protected directories. Matched as **exact path** OR **prefix where the next
 * char is a separator** — never raw substring. Listed without trailing slash;
 * the comparator handles separators.
 */
const PROTECTED_DIRS = [
  "/.ssh",
  "/.gnupg",
  "/.aws",
  "/.azure",
  "/.kube",
  "/.docker",
  "/.config/gh",
  "/.config/git",
  "/.config/gcloud",
  "/.config/op", // 1Password CLI
  "/.git", // git internals — refusing avoids tools mutating refs/objects
  "/.terraform.d",
  "/library/keychains",
  "/library/cookies",
  // System dirs holding host secrets/PII/process state. Per-PID files under
  // /proc leak env vars and command lines from other processes; /sys exposes
  // kernel state and hardware identifiers. /etc and /private/etc hold global
  // config that frequently contains credentials in basenames the regex won't
  // match (passwd, shadow, master.passwd, *.cnf, *.conf with creds).
  "/etc",
  "/private/etc",
  "/proc",
  "/sys",
  "/var/db",
  "/var/root",
  "/private/var/db",
  "/private/var/root",
  // Windows user profile equivalents (post drive-strip + lowercase).
  "/appdata/roaming/microsoft/credentials",
  "/appdata/local/microsoft/credentials",
  "/appdata/roaming/gcloud",
];

/**
 * Write-only deny prefixes (system locations). Read access is *not* universally
 * blocked — reading `/etc/hosts` is fine; writing to it isn't.
 */
const WRITE_DENY_PREFIXES = [
  "/etc/",
  "/var/db/",
  "/var/root/",
  "/system/", // case-folded from /System/
  "/library/keychains/",
  "/library/launchagents/",
  "/library/launchdaemons/",
  "/private/etc/",
  "/private/var/db/",
  "/usr/bin/",
  "/usr/sbin/",
  "/usr/local/bin/",
  "/bin/",
  "/sbin/",
  "/boot/",
  // Windows (post drive-strip + lowercase). Note: these block writes to the
  // system drive's Windows / Program Files. Drives are stripped, so any
  // /windows/... etc. matches regardless of drive letter.
  "/windows/",
  "/program files/",
  "/program files (x86)/",
  "/programdata/",
];

export type SafetyResult = { ok: true } | { ok: false; reason: string };

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Build a normalized *comparison surface* — never used as a real path:
 *  - back-slashes -> forward-slashes
 *  - strip Windows drive prefix (e.g. `C:`)
 *  - strip UNC prefix `//?/`
 *  - strip NTFS alternate-data-stream suffix (`name:stream` / `name::$DATA`)
 *    from each path segment — Windows reads `foo:stream` as `foo` for our
 *    purposes, so the comparison surface should too
 *  - strip trailing dots/spaces from each segment — Windows discards these
 *    at open time, so `.env.` and `.env ` open `.env`
 *  - collapse duplicate slashes
 *  - lowercase (so case variants match on case-insensitive filesystems)
 *  - drop trailing slash (except for root)
 */
function comparisonForm(p: string): string {
  let s = p.replace(/\\/g, "/");
  // UNC / extended-length prefix: \\?\C:\... or //?/C:/... → strip up to drive.
  s = s.replace(/^\/\/\?\//, "/");
  // Drive prefix: C:/foo → /foo. Important: do this BEFORE lowercasing so we
  // don't have to special-case "c:" vs "C:".
  s = s.replace(/^[a-zA-Z]:/, "");
  // Strip NTFS alternate-data-stream syntax from each segment. `name:stream`
  // and `name::$DATA` both read the same underlying file from `name`, so
  // they must compare-equal to `name`.
  s = s
    .split("/")
    .map((seg) => {
      const colon = seg.indexOf(":");
      return colon === -1 ? seg : seg.slice(0, colon);
    })
    .join("/");
  // Strip trailing dots/spaces from each segment (Windows behavior).
  s = s
    .split("/")
    .map((seg) => seg.replace(/[.\s]+$/, ""))
    .join("/");
  // Collapse duplicate slashes (//foo → /foo). Preserve a possible leading
  // single slash.
  s = s.replace(/\/{2,}/g, "/");
  s = s.toLowerCase();
  // Drop trailing slash so "/foo/" and "/foo" compare equal.
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function isUnderProtected(cmp: string, dir: string): boolean {
  // Protected dirs (`/.ssh`, `/.config/gh`, …) live under the user's home or
  // somewhere else in the tree — they are NOT root-anchored. Match the dir as
  // a path-segment substring: append `/` to both sides so we don't match
  // false positives like `/.sshx` against `/.ssh`.
  //
  //   "/users/me/.ssh/config" + "/" → contains "/.ssh/" ✓
  //   "/users/me/.ssh"        + "/" → contains "/.ssh/" ✓
  //   "/users/me/.sshx/file"  + "/" → does not contain "/.ssh/" ✓
  return (cmp + "/").includes(dir + "/");
}

function describeProtected(dir: string): string {
  // "/.ssh" -> ".ssh", "/.config/gh" -> ".config/gh"
  return dir.replace(/^\//, "");
}

export function checkReadable(path: string): SafetyResult {
  if (typeof path !== "string" || path.length === 0) {
    return { ok: false, reason: "Refused: empty path." };
  }
  // Reject NUL and control bytes in paths — these are never legitimate and
  // are a classic truncation/injection vector.
  if (/[\x00-\x1f]/.test(path)) {
    return { ok: false, reason: "Refused: path contains control bytes." };
  }

  const base = basename(path);
  for (const re of SECRET_BASENAME_PATTERNS) {
    if (re.test(base)) {
      return {
        ok: false,
        reason: `Refused: "${base}" matches a sensitive-file pattern.`,
      };
    }
  }

  const cmp = comparisonForm(path);
  for (const dir of PROTECTED_DIRS) {
    if (isUnderProtected(cmp, dir)) {
      return {
        ok: false,
        reason: `Refused: path is inside a protected directory (${describeProtected(dir)}).`,
      };
    }
  }

  return { ok: true };
}

export function checkWritable(path: string): SafetyResult {
  // Writes inherit all read restrictions, plus system-directory blocks.
  const r = checkReadable(path);
  if (!r.ok) return r;

  const cmp = comparisonForm(path);
  // Ensure the comparison surface has a leading separator for prefix matching.
  const cmpForPrefix = cmp.startsWith("/") ? cmp : `/${cmp}`;
  for (const prefix of WRITE_DENY_PREFIXES) {
    if (cmpForPrefix.startsWith(prefix) || `${cmpForPrefix}/`.startsWith(prefix)) {
      return {
        ok: false,
        reason: `Refused: writes under "${prefix.replace(/\/$/, "")}" are not allowed.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Destructive shell commands: `rm`/`mv` (and their Windows / PowerShell
 * equivalents) executed through `bash_run` / `bash_background` bypass the
 * file review entirely — no per-file proposal, no checkpoint, no Restore.
 * File tools (`delete_file` / `rename_file`) are the safe path for files,
 * but they refuse directories, so directory deletes can only happen
 * through the shell. This detector gives the approval card something
 * explicit to show, and lets `execute` refuse the catastrophic cases
 * outright.
 *
 * Two tiers:
 * - `catastrophic: true` — broad or system targets (root, home, the
 *   workspace root itself, bare wildcards, system / secret dirs).
 *   Refused in `execute`; the model is told to use the file tools.
 * - `catastrophic: false` — a scoped delete/move inside the workspace
 *   (`rm -rf dist`, `mv a.txt b.txt`). The approval card shows an
 *   explicit warning with the targets and the missing checkpoint; the
 *   user's Approve on that card is the informed approval.
 *
 * Best-effort by design (see the limitations in TERAX.md): detection
 * reads the command text, so indirection the text cannot see — `xargs
 * rm`, `$(rm ...)`, backticks, commands assembled from variables, or a
 * path smuggled through a pipe — is missed. The approval card, which
 * shows the command verbatim, remains the backstop for those.
 *
 * Deliberately NOT flagged:
 * - `git rm` / `git mv` — git operations on tracked files, recoverable
 *   with `git checkout` / `git restore`; flagging them would break
 *   routine git workflows (`git rm --cached`, `git mv` renames).
 * - Package-manager removes (`pnpm remove`, `npm rm`) and matches where
 *   `rm` is only an argument (`grep -r "rm" .`, `echo "rm -rf /"`):
 *   only the command word itself is matched, never its arguments.
 */
export type DestructiveShellCommand = {
  kind: "delete" | "move";
  /** Matched command segments, verbatim (trimmed). */
  commands: string[];
  /** Parsed operand targets (unquoted), in order. */
  targets: string[];
  catastrophic: boolean;
  reason: string;
};

const DELETE_WORDS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "del",
  "erase",
  "rd",
  "remove-item",
]);

const MOVE_WORDS = new Set([
  "mv",
  "move",
  "ren",
  "rename",
  "move-item",
  "rename-item",
]);

/** System locations a shell delete must never touch. */
const CATASTROPHIC_PREFIXES = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/boot",
  "/system",
  "/library",
  "/var",
  "/private",
  "/windows",
  "/program files",
  "/program files (x86)",
  "/programdata",
];

/** Home secret dirs (same set as PROTECTED_DIRS, home-relative). */
const CATASTROPHIC_HOME_DIRS = [
  "/.ssh",
  "/.gnupg",
  "/.aws",
  "/.kube",
  "/.azure",
  "/.docker",
  "/.config",
];

/**
 * Split a single-line command into `;` / `&&` / `||` / `|` / `&`
 * segments, respecting single/double quotes and backslash escapes.
 * (CR/LF are already refused by checkShellCommand, so commands here
 * are single-line.)
 */
function splitShellSegments(cmd: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      current += ch;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|") {
      if (
        (ch === "&" && cmd[i + 1] === "&") ||
        (ch === "|" && cmd[i + 1] === "|")
      ) {
        i += 1;
      }
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Split one segment into tokens, stripping quotes (keeps the content). */
function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let hasToken = false;
  const push = () => {
    if (hasToken || current.length > 0) tokens.push(current);
    current = "";
    hasToken = false;
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      push();
      continue;
    }
    current += ch;
    hasToken = true;
  }
  push();
  return tokens;
}

/** Strip leading wrappers (`sudo`, `command`, `env`, `VAR=x`, flags). */
function stripWrappers(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i += 1;
      continue;
    }
    if (
      t === "sudo" ||
      t === "command" ||
      t === "time" ||
      t === "nice" ||
      t === "env"
    ) {
      i += 1;
      continue;
    }
    if (t === "-u" || t === "-g") {
      i += 2;
      continue;
    }
    if (t.startsWith("-") && t !== "-") {
      i += 1;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

/** Basename + `.exe` strip + lowercase, for command-word matching. */
function commandWord(token: string): string {
  const base = token.replace(/\\/g, "/").split("/").pop() ?? token;
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

/** Normalization surface for operand comparison (never a real path). */
function normalizeOperand(op: string): string {
  let s = op.replace(/\\/g, "/");
  s = s.replace(/^[a-zA-Z]:/, "");
  s = s.replace(/^~(?=\/|$)/, "");
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s.toLowerCase();
}

function isCatastrophicOperand(op: string): boolean {
  const n = normalizeOperand(op);
  // Bare broad targets: root, home, workspace root, bare wildcards.
  if (
    n === "" ||
    n === "/" ||
    n === "." ||
    n === ".." ||
    n === "*" ||
    n === "**" ||
    n === "$home" ||
    // Written as a regex, not the string literal "${home}": the literal
    // trips noTemplateCurlyInString and reads as a template placeholder.
    /^\$\{home\}$/.test(n) ||
    n === "%userprofile%" ||
    n === "%homepath%"
  ) {
    return true;
  }
  // Wildcards rooted at a broad location. `*.log` in one directory is
  // scoped (warn only), but `*`, `./*`, `/*`, `*/*.txt` reach a whole
  // directory tree or the filesystem root.
  if (n.includes("*") || n.includes("?")) {
    const rawPrefix = n.split(/[*?]/)[0];
    const p = rawPrefix.endsWith("/")
      ? rawPrefix.slice(0, -1)
      : rawPrefix;
    if (p === "" || p === "." || p === "/" || p === "~") {
      if (/^[*?]+$/.test(n) || n.includes("/")) return true;
    }
  }
  // System locations, exact or descendant (segment boundary).
  const cmp = n.startsWith("/") ? n : `/${n}`;
  for (const prefix of CATASTROPHIC_PREFIXES) {
    if (cmp === prefix || cmp.startsWith(`${prefix}/`)) return true;
  }
  // Home secret dirs.
  for (const dir of CATASTROPHIC_HOME_DIRS) {
    if (isUnderProtected(cmp, dir)) return true;
  }
  return false;
}

/** Operands of one rm/mv-style command: flags skipped, `--` ends flags. */
function parseOperands(tokens: string[], isWindowsBuiltin: boolean): string[] {
  const operands: string[] = [];
  let endOfFlags = false;
  for (const t of tokens) {
    if (!endOfFlags && t === "--") {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && t.startsWith("-") && t !== "-") continue;
    // cmd builtins take /q /f /s flags; a bare "/" is the root operand.
    if (!endOfFlags && isWindowsBuiltin && /^\/[a-zA-Z]/.test(t)) continue;
    operands.push(t);
  }
  return operands;
}

export function detectDestructiveShellCommand(
  cmd: string,
): DestructiveShellCommand | null {
  const found: {
    kind: "delete" | "move";
    segment: string;
    targets: string[];
    catastrophic: boolean;
  }[] = [];
  for (const segment of splitShellSegments(cmd)) {
    const tokens = tokenizeSegment(segment);
    if (tokens.length === 0) continue;
    const stripped = stripWrappers(tokens);
    if (stripped.length === 0) continue;
    const word = commandWord(stripped[0]);
    const rest = stripped.slice(1);

    // `git rm` / `git mv`: versioned, recoverable — not shell deletion.
    if (word === "git" && (rest[0] === "rm" || rest[0] === "mv")) continue;

    // `find <root> -delete` / `-exec rm|mv ...`: the root is the target.
    if (word === "find") {
      const hasDelete = rest.includes("-delete");
      const execIdx = rest.findIndex(
        (t) => t === "-exec" || t === "-execdir",
      );
      const execWord =
        execIdx >= 0 && execIdx + 1 < rest.length
          ? commandWord(rest[execIdx + 1])
          : null;
      const kind = hasDelete
        ? "delete"
        : execWord && DELETE_WORDS.has(execWord)
          ? "delete"
          : execWord && MOVE_WORDS.has(execWord)
            ? "move"
            : null;
      if (!kind) continue;
      const root = rest.find((t) => !t.startsWith("-")) ?? ".";
      found.push({
        kind,
        segment,
        targets: [root],
        catastrophic: isCatastrophicOperand(root),
      });
      continue;
    }

    const isDelete = DELETE_WORDS.has(word);
    const isMove = MOVE_WORDS.has(word);
    if (!isDelete && !isMove) continue;
    const isWindowsBuiltin = ["del", "erase", "rd", "move", "ren", "rename"].includes(word);
    const targets = parseOperands(rest, isWindowsBuiltin);
    // A bare `rm` / `mv` with no operands deletes nothing.
    if (targets.length === 0) continue;
    // `rm -rf` under the home dir is already refused by
    // checkShellCommand (even `rm -r -f ~/x`, which its regex misses);
    // mark it catastrophic here too so the approval card and the
    // execute refusal agree instead of showing a mere warning.
    let catastrophic = targets.some(isCatastrophicOperand);
    if (!catastrophic && word === "rm") {
      const flags = rest.filter((t) => t.startsWith("-") && t !== "-");
      const recursive = flags.some(
        (f) => /^-[a-zA-Z]*[rR]/.test(f) || f === "--recursive",
      );
      const force = flags.some(
        (f) => /^-[a-zA-Z]*f/.test(f) || f === "--force",
      );
      catastrophic =
        recursive &&
        force &&
        targets.some(
          (t) =>
            t === "~" ||
            t.startsWith("~/") ||
            t.startsWith("$HOME") ||
            // Regex, not the "${HOME}" literal (noTemplateCurlyInString).
            /^\$\{HOME\}/.test(t),
        );
    }
    found.push({
      kind: isDelete ? "delete" : "move",
      segment,
      targets,
      catastrophic,
    });
  }
  if (found.length === 0) return null;
  const targets = found.flatMap((f) => f.targets);
  const catastrophic = found.some((f) => f.catastrophic);
  const kinds = [...new Set(found.map((f) => f.kind))];
  const kind = kinds.includes("delete") ? "delete" : "move";
  const targetList =
    targets.slice(0, 5).join(", ") +
    (targets.length > 5 ? ` (+${targets.length - 5} lainnya)` : "");
  return {
    kind,
    commands: found.map((f) => f.segment),
    targets,
    catastrophic,
    reason: catastrophic
      ? `Refused: ${kinds.join(" + ")} targets a broad or protected location (${targetList}). This command was not executed. To delete specific files use the delete_file tool (reviewed, restorable); to rename use rename_file.`
      : `${kinds.join(" + ")} ${targetList} via shell — no checkpoint, cannot be Restored. For files, prefer the delete_file / rename_file tools (reviewed, restorable).`,
  };
}

/**
 * Two-phase safety check that also defends against symlink traversal: first
 * checks the literal path, then (if it exists) canonicalizes it via the
 * native FS and re-checks the resolved path. A symlink at `./innocent.txt`
 * pointing into `~/.ssh/id_rsa` is caught on the second pass.
 *
 * Returns the canonical path on success so callers can use it for the actual
 * read — avoids TOCTOU between the safety check and the read.
 */
export async function checkReadableCanonical(
  path: string,
  canonicalize: (p: string) => Promise<string>,
): Promise<{ ok: true; canonical: string } | { ok: false; reason: string }> {
  const initial = checkReadable(path);
  if (!initial.ok) return initial;
  let canonical: string;
  try {
    canonical = await canonicalize(path);
  } catch {
    // Path doesn't exist yet — fine for the read tool to surface ENOENT.
    return { ok: true, canonical: path };
  }
  // Always recheck — even when canonicalize returns the same string, the
  // checks themselves can have OS-specific gaps (NTFS streams, trailing
  // dot/space) that warrant a second pass against the comparison form.
  const recheck = checkReadable(canonical);
  if (!recheck.ok) return recheck;
  return { ok: true, canonical };
}

/**
 * Same pattern as {@link checkReadableCanonical} but for writes. The canonical
 * path is only available if the file already exists — for new-file creates
 * we additionally canonicalize the parent directory.
 */
export async function checkWritableCanonical(
  path: string,
  canonicalize: (p: string) => Promise<string>,
): Promise<{ ok: true; canonical: string } | { ok: false; reason: string }> {
  const initial = checkWritable(path);
  if (!initial.ok) return initial;
  // Try canonicalizing the target itself first.
  try {
    const canonical = await canonicalize(path);
    // Always recheck the canonical form — same rationale as checkReadableCanonical.
    const recheck = checkWritable(canonical);
    if (!recheck.ok) return recheck;
    return { ok: true, canonical };
  } catch {
    // Target doesn't exist — canonicalize the parent so we still catch a
    // symlinked parent directory (`./project -> /Users/me/.ssh`).
    const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (lastSep > 0) {
      const parent = path.slice(0, lastSep);
      const tail = path.slice(lastSep);
      try {
        const canonParent = await canonicalize(parent);
        const recheckParent = checkWritable(canonParent + tail);
        if (!recheckParent.ok) return recheckParent;
        return { ok: true, canonical: canonParent + tail };
      } catch {
        // Parent doesn't exist either — let the caller surface the actual error.
      }
    }
    return { ok: true, canonical: path };
  }
}

export function checkShellCommand(cmd: string): SafetyResult {
  const c = cmd.trim();
  if (c.length === 0) {
    return { ok: false, reason: "Refused: empty command." };
  }
  // Block C0 controls. CR/LF would let a second statement smuggle past the
  // approval UI, which shows the command as one logical line.
  if (/[\x00-\x1f]/.test(c)) {
    return {
      ok: false,
      reason:
        "Refused: command contains control characters (including CR/LF). Commands must be single-line.",
    };
  }
  // Block Unicode bidi-override and invisible directional marks. These let an
  // attacker craft a command whose visual order (in the approval UI's <pre>
  // block) differs from its logical execution order — a Trojan Source attack.
  // Legitimate shell commands do not need RTL overrides.
  if (/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/.test(c)) {
    return {
      ok: false,
      reason: "Refused: command contains Unicode bidirectional override characters.",
    };
  }
  // rm -rf / (and variants with quoted /, --no-preserve-root, etc.)
  if (
    /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|--recursive\s+--force|--force\s+--recursive)\s+(['"]?\/['"]?\s*($|;|&|\|))/.test(
      c,
    )
  ) {
    return {
      ok: false,
      reason:
        "Refused: command attempts to recursively delete the filesystem root.",
    };
  }
  // rm -rf ~ / $HOME / ${HOME}, with or without a trailing path — wiping the user's home dir
  if (
    /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(['"]?(~(\/[^\s'"]*)?|\$\{?HOME\}?(\/[^\s'"]*)?)['"]?)(\s|$|;|&|\|)/.test(
      c,
    )
  ) {
    return {
      ok: false,
      reason: "Refused: command attempts to recursively delete the home directory.",
    };
  }
  if (/--no-preserve-root/.test(c)) {
    return { ok: false, reason: "Refused: --no-preserve-root is not allowed." };
  }
  // dd to a raw disk device
  if (/\bdd\b[^|]*\bof=\/dev\/(disk|sd|nvme|hd)/i.test(c)) {
    return { ok: false, reason: "Refused: dd to a block device is not allowed." };
  }
  // mkfs / fdisk / diskutil eraseDisk / parted
  if (
    /\b(mkfs(\.[a-z0-9]+)?|fdisk|parted)\b/.test(c) ||
    /\bdiskutil\s+erase/i.test(c)
  ) {
    return {
      ok: false,
      reason: "Refused: disk-formatting commands are not allowed.",
    };
  }
  // Fork bomb
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/.test(c)) {
    return { ok: false, reason: "Refused: fork-bomb pattern detected." };
  }
  // Pipe-to-shell from network. The user already approves the command, but
  // this combo is overwhelmingly malicious-payload-shaped and worth flagging.
  if (/\b(curl|wget)\b[^|;&]*\|\s*(ba|z|k|d|fi|c)?sh\b/.test(c)) {
    return {
      ok: false,
      reason:
        "Refused: piping a network download directly into a shell is blocked. Download first, inspect, then run.",
    };
  }
  return { ok: true };
}
