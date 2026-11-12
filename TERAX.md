# TERAX.md

Terax loads `TERAX.md` from the workspace root as agent memory (similar to AGENTS.md / CLAUDE.md). This file is also the project's living architecture doc - read it before making changes.

## Project

**Terax**: open-source AI-native terminal emulator. Tauri 2 + Rust (`portable-pty`) backend, React 19 + TypeScript + libghostty-vt WASM client (WebGPU, Terax WebGL fallback), BYOK AI via Vercel AI SDK v6.

- Bundle id: `app.crynta.terax`
- Package manager: **pnpm**
- Platforms: macOS, Linux, Windows
- Frontend checks: `pnpm lint`, `pnpm check-types`, `pnpm test`
- Rust checks: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`, `cd src-tauri && cargo nextest run --locked` (local fallback: `cargo test --locked`)

## Quality bar

Production-grade or it does not ship. Every change is judged against all of these, not just "it works":

- **Correctness**: edge cases, failure modes, concurrent access. No "works for now".
- **Performance**: ultra-lightweight is the product. ~7-8 MB bundle, high-performance terminal. For every change ask: how much RAM it costs, whether it adds IPC round-trips or redundant requests, whether it triggers extra re-renders or wasted work, whether it pulls a heavy dependency. Unused features consume zero resources.
- **Security**: no critical security holes. Validate at every boundary (IPC, fs, network, AI tool surface). The secret-path deny-list applies on both read and write and is never bypassed.
- **UI/UX**: polished, professional, premium. Every state and detail considered.
- **Architecture**: new or changed logic lives in pure, dependency-light functions (functional core); tauri commands and React components stay thin (imperative shell). Keeps it testable without a later rewrite.

Verify before claiming done:

- Frontend: `pnpm lint`, `pnpm check-types`, `pnpm test`
- Rust: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`, `cd src-tauri && cargo nextest run --locked` (or `cargo test --locked`)

A change to a core subsystem (terminal/shell spawn, workspace auth, git, fs, IPC or AI tool surface) needs a test that locks the invariant.

## Terminal migration status

libghostty-vt is the only terminal model. WebGPU is the default renderer and
Terax WebGL is the compatibility fallback. Each leaf owns one persistent model
in its own WebAssembly instance (the module is compiled once and shared), so
closing a leaf drops its linear memory and scrollback instead of leaving a
high-water mark; nothing may retain a view into a disposed model's memory.
Scrollback summed over all leaves is capped by a budget (192 MiB, scaled fairly
between leaves, never pruning history already held). Presentation resources are
shared, bounded, and released for hidden leaves.
All visible WebGPU panes of a window draw into one canvas that covers the
terminal area (`gpu/WebGpuWindowCanvas.ts`; the `[data-terminal-area]` layer of
`TerminalStack`, behind the tab layers). Each pane renders into its device-pixel
snapped rectangle (`gpu/PaneRects.ts`, measured on layout changes only) with
`setViewport` and `setScissorRect`, which keeps glyph overhang out of the
neighbour; the shader takes viewport size and origin from the uniform, so a
pane's pixels equal what a canvas of its own showed (verified byte for byte,
`scripts/terminal-visual/grid.html`). Canvas textures are not preserved between
frames, so a window frame clears the canvas and encodes every visible pane in one
pass (cell buffers stay resident on the GPU, no per-cell work). Per-pane dirty
tracking still decides whether a frame is needed: an unchanged window acquires
no texture (`windowFrameNeeded`). `SurfaceFramePacer` decides which panes prepare
in a frame; a pane whose rectangle moved always does. Pane DOM is transparent
once the canvas has shown the pane's first frame (until then it paints the theme
colour, so a tab switch never flashes the card behind); scrollbars, selection,
IME, block overlays and cursor styles stay per-pane DOM above the canvas.
A presented WebGPU canvas is never destroyed, unconfigured, shrunk or
dropped while the runtime lives: WebKit (macOS 26) keeps the swapchain of such a
canvas in the WebContent process for good (three buffers, about 30 MiB for a
2000x1300 canvas, whatever the teardown order and garbage collection), and keeps
every swapchain a resizing canvas retires until JavaScriptCore collects its
wrappers (minutes), so every teardown or resize leaks. A tab switch, a split or a
divider drag therefore only changes viewports: zero canvas allocations. The
canvas is reallocated only when the terminal area itself changes size, at most
twice per window drag (below). With no visible pane (an editor tab is active) or
an occluded window it is paused (hidden after a short delay when empty), never released. A replaced or
recovered GPU device reconfigures the same element, and a remounted area takes
over the old one's canvas. Only disposing the runtime tears it down. The WebGL
fallback stays per pane (its own canvas and opaque background inside the pane
root): a WebGPU failure in one pane falls that pane back, and a failure of the
shared runtime falls every pane back.
Every submitted window frame is mirrored to JavaScriptCore (`gpu/GcPressure.ts`):
the wrappers of a frame (texture, view, encoder, pass, command buffer) pin about
13 KiB of WebKit malloc that JavaScriptCore does not count, so without help it
collects them after minutes (20 MiB a minute for a streaming agent). Allocating and
dropping a 126 KiB `ArrayBuffer` per frame (ten times the native cost; measured:
unfinalized canvas textures after 120 s 2,626 without, 195 with it, no change in
instructions per second) makes young-generation collections run steadily. At most
4 MiB a second is mirrored, so display-rate frames allocate no more than a 25 fps agent.
Resizing applies one synchronized model + PTY resize per gesture. Every SIGWINCH
makes zsh/fish and Ink-based agents redraw, and redraws that do not line up with a
reflowed grid leave duplicates in scrollback, so during a resize gesture (native
macOS live resize via `NSWindowWillStart/DidEndLiveResize`, forwarded as
`liveResize` in `terax:window-presentation`; a pane divider drag via
`terminalResizeInteraction`; elsewhere a burst of size changes less than 150 ms
apart, `lib/terminalResizeGesture.ts`) neither the model nor the PTY changes. The
pane follows the pointer at display rate (`SurfaceFramePacer` gesture mode) and
draws its existing grid: shifted up (`shift_y`) so the cursor row stays visible
when the pane is shorter, clipped on the right or padded with the background
otherwise. At release `TerminalResizeSync` resizes the model and tells the PTY in
one call, model first. Ghostty clears the prompt on that resize and relies on the
shell's redraw, so the pane holds its previous frame until the redraw ends or
70 ms pass (`core/ResizePromptHold.ts`; only at an OSC 133 prompt, never in the
alternate screen). Resizes outside a gesture (sidebar, font, ratio, first fit,
showing a hidden pane) apply at once. During a gesture the window canvas's backing
store is grow-only: it keeps its allocation while the area shrinks and, when the
area outgrows it, allocates once to the largest size it can reach
(`gpu/GestureBacking.ts`: the area plus the screen room left when the window
itself is dragged, else the window; capped by the device limit), then compacts at
release, so a drag costs at most one growth and one compaction. The WebGL
fallback defers the same way per pane (top-anchored).

The WebGPU path (renderer v2, `docs/architecture/terminal-renderer-v2.md`) runs
no per-cell JavaScript. Ghostty encodes 16-byte cell records natively and
reports only rows whose bytes changed. The surface uploads those ranges straight
from WASM memory (`consumeGpuFrame`) into a storage buffer, and nothing may call
the model between that frame and the upload because the view is borrowed. It
never touches the structure-of-arrays APIs, which would flip the model's format;
only the WebGL fallback uses them. A background pass derives each cell from its
pixel (background, search, selection, cursor, decorations) and an instanced
glyph pass draws integer-pixel quads with unfiltered `textureLoad`. Selection and
cursor are uniforms and the search highlight is a mask buffer that exists only
while something is highlighted, so none of them rewrites cell records.
Geometry is pixel exact. Fonts are measured at size times ratio and cells are
whole device pixels (`TerminalFontMetrics.deviceCell*`). `cellWidth` and
`cellHeight` are the CSS size, device divided by ratio, and are what fit,
hit-testing, selection, links and block overlays use. A pane's rectangle in the
window canvas holds at least cols by rows device cells (slack is background, the
scissor clips the rest) and the canvas origin is translated onto the device
pixel grid when the observer, ratio or window size changes. A ratio change
re-measures the font and rebuilds atlas and buffers.
Each terminal maps Ghostty glyph ids to a glyph atlas shared per font and ratio.
The atlas grows (coverage 1024 to 2048 to 4096, colour 512 to 2048) before it
flushes into a new epoch; after a flush each surface rescans its visible cells and
re-rasterizes only what it shows. Rasterization is limited to about two
milliseconds per frame across surfaces, leftover glyphs draw on follow-up frames,
and a backlog from scrolled-away output keeps only visible glyphs queued.
Grayscale text gets a DirectWrite-style contrast curve when the ratio is below 2
or on Windows and Linux (`localStorage["terax:terminal-text-contrast"]` is
`off`, `on` or a strength); macOS Retina is unchanged.
Box drawing, block elements, braille, powerline separators and common legacy
computing shapes are drawn procedurally at exactly the cell size, not from the
font, with Ghostty's sprite geometry (`gpu/BuiltinGlyphs.ts`, pure, shared by
the WebGPU and WebGL atlases), so borders and bars join seamlessly at every size
and ratio. They ignore bold and italic and skip the text contrast curve.
Native cell, grapheme and hyperlink presentation buffers allocate on first use
and return to the WASM allocator when a pane is hidden. Hidden parsing does not
rebuild them. Window pauses (occlusion, sleep) retain them and the uploaded cell
data.
Unchanged frames do not acquire presentation textures or draw; cursor-only
updates upload only the uniform. WebGL background and decoration geometry uses
row range uploads while rectangle counts are stable; structural changes rebuild
the compact stream. Scrollbar synchronization never reads the DOM on presented
frames; moving the thumb under a bottom-pinned view costs at most ten position
writes and four ARIA updates a second. Blink timers stop in unfocused windows,
and native cursor hiding stops cursor timers. Selection is a uniform and needs no
row damage; streaming search invalidations coalesce instead of rebuilding per
output chunk.
WebGL surface and renderer code load only when selected, needed for fallback,
or explicitly requested by diagnostics. Delayed imports cannot install into a
closed, restarted, or replaced session.
xterm, its addons, CSS, snapshots, session pool, and dormant byte ring are removed.
Unsupported graphics produce a visible error with retry instead of changing models.

Command blocks use parser-time Ghostty tracked pins, including endpoint columns,
so command ranges survive reflow and exclude following prompts and commands.
The native marker ring is capped at 2,048 pins; JavaScript history is capped at
1,000 blocks and 512 KiB of estimated UTF-16 command/cwd text. Block implementation
and UI load only for block sessions, and hidden/occluded block presentation stops.
Block search yields after 128 rows or four milliseconds, retains at most 500
matches, and cancels obsolete queries. Block copy, search, sticky headers, navigation, Ask AI, rerun, shared shell input,
and selection all use the same persistent Ghostty model.
Block chrome commits with its matching renderer frame; it is recomputed only when
the viewport origin, scrollback, size, cell height, block mode or block set
(`GhosttyBlocks.revision`) changed, so frames that only repaint cells cost no
block work and no React commit. The per-frame path reads cached cell metrics, never
layout, and the shell/prompt input switch runs on block-mode changes, not per PTY
chunk. Command-editor focus does
not lower active-pane cadence. Divider padding is presentation-only and does not
change copied command boundaries. Scrollbars preserve native fractional positions
and ignore delayed programmatic scroll events. Hidden output does no surface DOM
or search-mask work until presentation resumes.

Terminal clipboard shortcuts use the native text clipboard plugin on all desktop
platforms. Context clicks expose the selected text through the input element to
restore the webview's native text menu; no persistent DOM scrollback is maintained.
On macOS the input `<textarea>` always holds one selected placeholder character
(`TerminalInputProxy`; elsewhere it stays empty, a selection could take X11 PRIMARY): a focused editable with a collapsed selection keeps
WebKit's caret animation (a display link at display rate) running at ~3 % CPU and
~250 wakeups/s while idle, a non-collapsed selection paints no caret (0.2 %, ~10/s).
It re-arms after input, key release and focus, never during IME composition, and
native Copy/Cut without terminal text must not copy the placeholder.
Unclaimed macOS Command shortcuts reach the native menu after explicit clipboard,
block-editor, and readline bindings, including when Kitty keyboard mode is active.
The block prompt retains an enabled terminal input proxy for native menus and
routes editing keys, composed text and paste back to its command editor.
Character drags retain a native selection pin from pointerdown, including before
the first pointermove. Unmoved clicks and lost captures discard provisional pins.
Key encoding supplies the base character required by Kitty keyboard mode; plain
keys and key releases also use Ghostty encoding when the application requests it.
Terminal text uses the configured font, an installed Nerd Font when detected,
or bundled JetBrains Mono. Private-use prompt symbols require an installed font
that supplies them; Terax does not ship a separate symbol font. Native color
emoji remain on the system fallback path. Rerun requires the complete command
submitted through Terax; truncated shell labels are never executed.
Primary-screen full erase, scrollback erase, and terminal reset invalidate block
pins at parse time and clear block chrome, selection, and search. Commands after
an erase in the same output chunk retain their new pins. Alternate-screen erases
preserve primary block history. Block scrollbar status dots are removed along
with their timers and history scans.

The shared command bar activates after shell integration confirms prompt input.
Bare shells keep direct terminal input. Bash before 4.4 reports
`OSC 133;B;terax_blocks=0` and keeps its native prompt because it lacks PS0.

Settings offer Automatic or WebGL for new terminals, plus opt-in screen reader
output. Accessible text is limited to 256 rows / 64 KiB and refreshes at most four
times per second while visible. Ordinary URL detection runs on pointer demand;
OSC 8 links take precedence. OSC 52 side effects retain one in-flight write and
only the latest pending value across the window.

The adapted Ghostty revision is pinned in `packages/ghostty-core/adapted/UPSTREAM.md`.
Both SIMD and scalar artifacts are shipped; the loader fetches only the variant
the webview supports. Scalar validation explicitly disables SIMD instructions
and types. This avoids changing OS minimums solely for the WASM SIMD requirement;
actual older WKWebView and WebKitGTK compatibility still needs platform tests.

PTY output is one multiplexed pull stream per window (`docs/architecture/pty-transport-v2.md`),
not a channel per terminal. The async `terax-pty` URI scheme (`pty/protocol.rs`) has two POST
endpoints: `poll`, kept outstanding exactly once per webview, and `ack`. One process-wide hub
thread (`pty/hub.rs`, scheduler in plain data driven by explicit time) holds the poll's responder
and answers with framed binary data (`pty/wire.rs`: `[u32 id][u8 kind][u32 len]`, kinds data, exit,
failed, sync; data frames carry their stream offset; responses are capped at 1 MiB) for every
terminal whose coalescing deadline is due. A terminal's presentation class picks its deadline:
focused 4 ms (16 ms sustained), visible 16 ms, hidden 100 ms, window occluded or asleep 250 ms;
256 KiB pending is always due, and terminals due within 4 ms ride in the same response (one
terminal contributes at most 512 KiB per response, so floods pipeline and share). The
frontend reports classes only on change (`pty_set_presentation`, from `lib/ptyPresentation.ts`);
each report carries a growing sequence number and a terminal keeps the newest one that named it,
because async commands can be applied out of order. macOS occlusion and sleep reach the hub natively
from `window_presentation.rs`. The stream token from `pty_stream_open` is the credential: any frame
can reach the scheme but only the page can invoke, so every request is admitted (`pty/gate.rs`) on
the handler's thread before it may wake the hub: the `Origin` must be the app's own
(`tauri://localhost`, `http(s)://tauri.localhost` on Windows, the dev server in dev builds; a request
without `Origin` is token-only), the body at most 3084 bytes (413) and well framed (400), and the
token the live one for the requesting webview (403; the hub publishes label to token, compared in
constant time). Responses echo the allowed origin with `Vary: Origin`, never `*`. Tokens come from OS
entropy only: if it fails, `pty_stream_open` fails instead of falling back to the clock. A terminal's
output is held until its receiver announces itself, and reload or window
destruction drops the held responder, kills the token and detaches that window's terminals.
Frontend `PtyOutputHub` owns the loop: it re-polls on a response before parsing and demultiplexes
to the `PtyOutputReceiver`s, whose cumulative parsed offsets ride on the next poll. An ack-only
request goes out only for new receivers, for more than 512 KiB of unsent progress, or when native
sends `sync` because it waits on that terminal (credit blocked or exiting).

Receivers parse in at most 32 KiB slices with a four-millisecond work budget on a shared FIFO
MessageChannel task queue, which closes its ports when idle. Only fully parsed original chunks
earn credit. Credit is bytes: at most 1 MiB in flight (128 chunks) and 2 MiB pending plus in
flight per terminal. Acknowledgments are cumulative offsets validated against delivered chunk
boundaries, so duplicates and retries cannot grant credit; a bad boundary or stream gap fails only
that terminal visibly. Parser failures stop delivery without acknowledging unconsumed bytes.
Transport failures retry with capped backoff and surface as one stalled/failed toast per
terminal. Exit waits for the reader drain and the final acknowledgments; the `exit` frame always
follows that terminal's last data frame. Unix readers sleep on PTY readiness plus an explicit
shutdown signal without a polling timer. After shell exit they consume ready output, bounded to
2 MiB / 30 seconds, rather than wait indefinitely for an inherited slave descriptor to close.
Exceeding this drain bound reports a reader failure and exit status -1. After shell exit,
30 seconds without acknowledgment progress closes a stalled queue with a logged delivery failure
and exit status -1. The deadline is armed before ConPTY close and thread joins; it does not run
during live-shell backpressure. Close wakes blocked queue workers and the Unix reader; Windows
keeps draining the pipe while ConPTY closes. Per-read costs stay low: the agent and DA filters
scan with `memchr` and copy runs, the reader checks an atomic `closed` flag and reuses its
buffers, input goes through one bounded queue to a per-session writer thread, worker threads use
128-256 KiB stacks, and `pty_has_foreground_process` lists children with `proc_listchildpids` or
`/proc/<pid>/task/*/children` instead of forking `pgrep`.

Enable release diagnostics with `localStorage.setItem("terax:terminal-diagnostics", "1")`
and reload. `window.__teraxTerm()` reads frontend counters;
`await window.__teraxTermSnapshot()` adds native queue counters and explicitly
labeled host RSS. Host RSS
excludes WebContent and GPU processes and is not total application memory.

Ghostty presentation uses shared native macOS occlusion/sleep and DOM visibility
tracking. Every renderer pauses immediately. The WebGPU renderer does nothing
more: frames and timers stop, while the window canvas (configured, at full size), cell
buffers, glyph maps and atlas textures stay resident, so coming back from a
Space switch, minimize or sleep costs one redraw and no allocation. Releasing
them is worse than keeping them (see the window canvas above). The WebGL fallback
still reclaims its renderer after two seconds of continuous occlusion, and at
once on sleep, because its dropped canvases are garbage collected (measured:
transient, no growth). Hidden tabs release their buffers and atlas lease immediately and
leave the window canvas (its size is kept). Per-pane pacing prevents focused output from
raising background pane cadence. Panes that are neither focused nor being
interacted with snap to one shared tick (30 Hz, 15 Hz in an unfocused window):
a pane that turns dirty waits for the end of its tick and presents with every
other pane of that tick in one encoder, submission and commit, at most once per
tick. The planner asks for an animation frame only for the vsync that can serve
the next deadline (the refresh interval and phase are learned from callback
timestamps), sleeping on a timer otherwise, so a 120 Hz display does not pay a
callback per vsync. A timer sleeping for a later tick is re-planned when a pane
that is due sooner turns dirty, so the focused pane never waits behind it.
WebGPU permits at most two outstanding frame submissions and keeps one
`onSubmittedWorkDone` wait outstanding at a time: frames submitted while it is
pending ride the next wait, which starts when it resolves (waiting only every
second frame was tried and cut a 32 Hz producer to 23 presented frames a second).
User wheel, drag, and keyboard interaction gives only its pane 150 ms of focused
cadence, including in an unfocused visible window. It starts no idle timer or
frame loop.
`window.__teraxTermTrace()` explicitly starts a bounded ten-minute resource trace;
it is never started automatically. `pnpm soak:ghostty` exercises real WASM models
without launching the application. `pnpm profile:ghostty` compares allocation
and parsing workloads in a fresh process per artifact and optional baseline.
`pnpm profile:renderer:macos` exercises the real renderer in an isolated native
WKWebView, including optional four-pane layouts and live visual inspection.
`scripts/terminal-visual` draws a fixed pattern through any source tree and reads
the canvas back as exact pixels for comparison.
`pnpm test:ipc:macos` verifies binary AI streaming, cancellation, and conversation
storage in a separate Tauri profile with synthetic local HTTP responses.
Resource evidence and limitations live in
`docs/architecture/ghostty-resource-efficiency.md`.

The release gates and current verification evidence are in
`docs/architecture/ghostty-release-readiness.md`. Automated checks alone do not
establish production readiness, platform parity, or multi-day resource stability.

## Conventions

- **Comments**: default to none, the code should explain itself. If genuinely needed, 1-2 lines on *why*, never *what*. No AI-generic filler.
- **No em-dash** anywhere: code, comments, commits, docs.
- **No emojis** anywhere.
- **Imports**: always `@/...` on the frontend, never relative across modules.
- **pnpm only**, never npm/npx/yarn.

## Architecture

### Two-process model

**Rust (`src-tauri/`)** owns all OS access. The webview never touches the FS, processes, or shells directly - everything goes through `invoke()` calls to commands registered in `src-tauri/src/lib.rs`:

- `pty::pty_*` - long-lived interactive PTY sessions (portable-pty ↔ Ghostty), managed by `PtyState` (`RwLock<HashMap<id, Session>>`). Output streams over the `terax-pty` multiplexed pull stream (hub thread, `pty_stream_open`, `pty_set_presentation`); input goes through a per-session writer thread.
- `fs::tree::*` (`fs_read_dir`, `list_subdirs`), `fs::file::*` (`fs_read_file`, `fs_write_file`, `fs_stat`, `fs_canonicalize`), `fs::mutate::*` (`fs_create_file`, `fs_create_dir`, `fs_rename`, `fs_move`, `fs_delete`, `fs_delete_batch`), `fs::copy::fs_copy`, `fs::clipboard::fs_clipboard_paths`: file explorer + editor IO. File paste captures the workspace and root before clipboard IPC. AppKit and GTK clipboard requests run on the main thread; Windows clipboard retries and filesystem copies run on blocking workers. `fs_copy` requires an authorized root, stages each item and publishes with a no-replace rename, and returns `{ created, failed }` with paths in the caller’s workspace representation. Conflict renaming uses `name copy N` siblings. Symbolic links are preserved without traversing them; copying a folder into itself is rejected. Explorer refresh and pasted selection ignore completions from an obsolete workspace.
- `fs::search::*` (`fs_search`, `fs_list_files`), `fs::grep::*` (`fs_grep`, `fs_grep_interactive`, `fs_glob`): fuzzy file finder + content search (powered by `ignore` + `grep-*` crates). File lists are cached per root in `fs::index` (packed buffer, at most two roots, 45 s TTL) and dropped by watcher events and our own mutations, so a keystroke ranks the cached list instead of re-walking the tree (a change reported during a cold walk marks that walk stale: its result is returned but not cached). Interactive searches bump a `fs::supersede` generation when the command is dispatched, so the walk of an older query stops while a newer one starts. Every command that touches the disk is `async` and runs on the blocking pool (`fs::blocking`): Tauri runs a plain command on the main thread, and the async runtime has two workers (`modules/runtime.rs`), so nothing blocking may run inline in an `async fn` either.
- `git::commands::*`: full source-control surface (`git_status`, `git_diff`, `git_diff_content`, `git_stage`, `git_unstage`, `git_discard`, `git_commit`, `git_fetch`, `git_pull_ff_only`, `git_push`, `git_log`, `git_show_commit`, `git_commit_files`, `git_commit_file_diff`, `git_panel_snapshot`, `git_resolve_repo`, `git_remote_url`). All gated through the workspace authorization registry. `git_status` asks git for `--untracked-files=normal` (one `dir/` entry per untracked directory) and expands small untracked directories back into files with a bounded `git ls-files --others` (500 files and 16 directories per refresh, listing abandoned at a 256 KiB cap); a directory over budget stays collapsed as `dir/`, which stage and discard handle natively.
- `shell::shell_run_command`: one-shot subshell exec used by AI tools (bounded `proc::capture`: two short reader threads, no wait on pipes a backgrounded grandchild keeps open). Distinct from PTY sessions; not the user's interactive terminal. On Windows via PowerShell (`-NoProfile -Command`), on Unix via `$SHELL -lc`. Shared helper `build_oneshot_command`.
- `shell::shell_session_*`: persistent agent shell with state across calls. `shell::shell_bg_*` (`spawn`, `logs`, `kill`, `list`): long-running background processes (dev servers etc.) with bounded ring-buffer log capture.
- `workspace::*`: `workspace_authorize` / `workspace_current_dir` (the spawn/git/AI cwd authorization registry) plus the WSL bridge (`wsl_list_distros`, `wsl_default_distro`, `wsl_home`).
- `lsp::*` (`lsp_detect`, `lsp_host_pid`, `lsp_resolve_root`, `lsp_spawn`, `lsp_send`, `lsp_kill`): language server process host. Dumb JSON-RPC pipe: Content-Length framing + process lifecycle in Rust (`lsp/framing.rs`, pure + tested), protocol intelligence on the frontend. Spawn cwd gated through the workspace registry; binaries resolve via the captured login-shell env (`lsp/env.rs`, GUI apps get a bare PATH on macOS); root detection walks up to markers but never to or above `$HOME`. Servers run in their own process group on Unix and are group-killed (cargo check / proc-macro children die with the server); Windows children get a `proc::job::ProcessJob` (kill-on-close, shared with pty). All sessions killed on `RunEvent::Exit`.
- `net::*` (`ai_http_stream`, `ai_http_cancel`, `ai_http_ack`, `lm_ping`): AI HTTP proxy with SSRF guard; keeps provider calls and local-model pings off the webview. Clients are cached per `(profile, host, pinned IPs, allow_private)` with a 90 s idle TTL and at most eight entries, so connections and HTTP/2 sessions are reused while DNS-rebinding protection stays per request. Classification (`net/ip.rs`) looks through IPv6 forms that carry an IPv4 destination (mapped, compatible, NAT64, 6to4, Teredo) and treats everything outside global unicast as non-public.
- `secrets::secrets_*`: OS keychain via the `keyring` crate. Service constant `terax-ai`. Linux uses a file-based fallback gated behind `#[cfg(target_os = "linux")]`.
- `open_settings_window`: separate webview window for Settings (optional `tab` arg deep-links a section).
- `vibrancy::window_*`: native window backdrop (`window_backdrop_kind`, `window_set_backdrop`). macOS gets `NSVisualEffectMaterial::UnderWindowBackground`, Windows 11 gets Mica (gated on build >= 22000 via `RtlGetVersion`, since `apply_mica` fails on Windows 10), Linux reports `none` because blur there belongs to the compositor. The `window-vibrancy` crate is a macOS/Windows-only dependency so Linux builds never pull it.

### PTY shell integration

PTY shells are bootstrapped via injected init scripts in `src-tauri/src/modules/pty/scripts/`:

- **Unix** (`zshenv.zsh`, `zprofile.zsh`, `zlogin.zsh`, `zshrc.zsh`, `bashrc.bash`) for zsh/bash, plus `init.fish` installed to `~/.config/fish/conf.d/terax.fish` for fish. Emit OSC 7 (cwd) and OSC 133 A/B/C/D (prompt boundaries + exit code) so the host can track cwd and detect command boundaries without re-parsing the prompt. Fish 4.0+ writes its own OSC 133 prompt markers; Terax sets `fish_features=no-mark-prompt` and re-asserts its own prompt via `-C` to avoid doubling.
- **Windows** (`profile.ps1`) - passed via `pwsh -NoLogo -NoExit -ExecutionPolicy Bypass -File <path>`. Wraps the user's existing `prompt` function (after their `$PROFILE` runs) to emit OSC 7 + OSC 133 A/B/D. Shell priority: `pwsh.exe` (PS 7+) → `powershell.exe` (PS 5.1) → `cmd.exe` (no integration). cwd is normalized to backslashes before being passed to ConPTY (`CreateProcessW` misbehaves with forward-slash cwd).

`pty/shell_init.rs` is split into `#[cfg(unix)]` / `#[cfg(windows)]` modules - keep new platform-specific code in the right cfg arm.

ConPTY on Windows requires `CONPTY_LIFECYCLE_LOCK` (Mutex) around `openpty + spawn_command` in `session.rs`. Concurrent spawns leave one of the resulting PTYs with a stalled output pipe. Don't remove the lock without verifying first-tab stability under fast tab spam. The lock must never be held across anything that waits on the frontend: the waiter lets the reader overdraft the output queue (`close_pseudoconsole`) before taking the lock for `ClosePseudoConsole`, so a backlog the page has not acknowledged cannot stall other `pty_open` calls.

Each ConPTY child is also assigned to a per-session **Job Object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (`pty/job.rs`). When the Job HANDLE drops - clean shutdown, panic, or even SIGKILL'd Terax process - the kernel kills every descendant of the shell (e.g. `npm run dev` spawned from inside pwsh). Without this Windows orphans the entire process subtree because `TerminateProcess` only kills the immediate child. macOS/Linux rely on `Drop for Session → killer.kill()`; on dev-`Ctrl-C` of `cargo run` destructors don't fire and orphans are possible there too - acceptable for now since dev only.

`AiComposerProvider` is mounted unconditionally at the App.tsx root: a conditional wrapper would change the parent element type when keys load, remounting the entire tree (and re-spawning every PTY) the moment `getAllKeys()` resolves. Production happened to dodge this because keychain reads can land in the same paint frame; dev didn't. Keep the unconditional wrap.

### Frontend (`src/`)

Single-window React app. Path alias `@/*` → `src/*`. Tabs are a tagged union (`kind`: `terminal` | `editor` | `preview` | `markdown` | `ai-diff` | `git-diff` | `git-history` | `git-commit-file`) and **not** unmounted on switch - they're hidden via `invisible pointer-events-none` so PTYs and dev servers keep streaming in the background.

`App.tsx` wires modules together - keep it a coordinator. New features go inside the appropriate `modules/<area>/`.

### Module layout (`src/modules/`)

Each module is self-contained, exports a thin barrel via `index.ts`, and owns its hooks under `lib/`.

- **terminal/** - `TerminalStack` keeps live leaves mounted. `useGhosttyTerminalSession` owns one persistent model and PTY per leaf; GPU/WebGL surfaces lease shared presentation resources independently. `terminalSessionApi.ts` exposes renderer-neutral product actions. OSC 7 paths and OSC 52 payloads are validated by pure parsers; Ghostty supplies OSC 133 events and native command anchors to the lazy block controller. WebGPU can fail over to WebGL without replacing the model, PTY, selection, search, or block history. Hidden models keep parsing through bounded PTY transport while presentation is released. There is no snapshot replay or second terminal parser. Theme colors come from the central theme engine.
- **editor/** - CodeMirror 6 stack (`EditorStack` mirrors `TerminalStack`). `extensions.ts` configures language modes; supports vim mode. Buffers live in LF space and the original EOL (`lib/eol.ts`, majority-vote detection) is restored on save; indent unit/tab size are detected per file (`lib/indent.ts`) via a per-pane compartment. Saves are conflict-checked against the disk mtime returned by `fs_read_file`/`fs_write_file` (mismatch → warning toast with explicit Overwrite, never silent last-writer-wins); external format-on-save only applies the disk read-back if the doc is unchanged since the save snapshot. Files over 10 MB offer "Open anyway" (hard cap 50 MB, `force` arg); above 4 MB syntax highlighting and LSP stay off. Cmd-F routes to CodeMirror's own search panel (find/replace/regex) when an editor tab is active, Ctrl-G opens go-to-line; both panels styled in `chromeTheme.ts`. Format-on-save formatters live in `lib/externalFormat.ts` (`FORMATTERS` registry: biome, prettier, ruff, rustfmt, gofmt, clang-format, shfmt, zig fmt, plus a custom `{file}` command template); `resolveFormatter` applies per-language overrides (`editorFormatterByLang`) over the global default, and a global external default only runs on languages its tool understands. Diff panes resolve the language before mounting CodeMirror: a late compartment reconfigure leaves the merge view's deleted-chunk widgets unhighlighted. AI inline completion (`lib/autocomplete/`) sends the buffer's indent unit with the request and normalizes unambiguous tab/space mismatches in responses (`normalizeIndent.ts`); triggering is `autocompleteTrigger` auto or manual, with `editor.aiComplete` / `editor.codeComplete` registry shortcuts (guarded to editor tabs so the keys fall through to terminals), and Tab accepts an open completion popup before the ghost. Multi-line ghosts render first-line-inline plus a block widget below the line (never inline `<br>`s); a closers-only line-suffix (cursor inside `fn(|)`) is hidden and re-appended after the block so the preview equals the accept result, and a line-suffix with real code caps the ghost to one line (`capToLineSuffix`). Suggestions echoing the recent prefix are dropped, multi-line suggestions and closing brackets never start on a line that ends with `;`, and closer-only lines are reindented from the previous line (`trimSuggestion`/`reindentClosers`, all tested). Markdown editing is GFM (`markdownLanguage` base) with fenced-code highlighting resolved through the shared lazy language registry, Cmd/Ctrl+Click URLs, and clickable task checkboxes (`markdownExtras.ts`, all inside the lazy markdown chunk; the eager-budget test enforces this). Dotenv files (`.env`, `.env.*`, and `*.env`) use the lazy shell grammar. Editor theme is decoupled from the app theme: the `editorTheme` pref is `"auto" | EditorThemeId` (default `"auto"`), resolved at render time by `useEditorThemeExt` via `resolveEditorThemeId`. In `auto` the editor follows the active app theme's `editorTheme[mode]` pairing (live, never stale); an explicit pick overrides. Theme ids + labels live in `settings/store.ts` (`EDITOR_THEMES`/`EDITOR_THEME_LABELS`); the matching extensions in `editor/lib/themes.ts` (`EDITOR_THEME_EXT`). Prebuilt `@uiw` themes plus locally-built ones in `editor/lib/cmThemes.ts` (Kanagawa wave/lotus/dragon, Everforest, Dracula, Solarized, Catppuccin, Rosé Pine) via `createTheme` (no extra deps). The three CM surfaces (`EditorPane`, `AiDiffPane`, `GitDiffPane`) all read the theme through `useEditorThemeExt`.
  Editor code size is stored separately as `editorFontSize` and does not affect `terminalFontSize`.
- **explorer/** - file tree with Catppuccin icons, fuzzy search, keyboard nav, inline rename, context actions. Backslash-aware `basename`. Icons are lazy: `iconResolver.ts` is the startup-safe shell and fetches the ~360 kB set (`iconEngine.ts`) when the first `FileIcon`/`FolderIcon` mounts; until then those components render a same-size blank slot that fades the icon in, and the set is never in either window's startup graph. The tree stays mounted when the sidebar collapses but is `visible={false}`: no native fs watchers (`watchRegistry.ts` disarms them), no `fs:changed` subscription, no drop listener and no reloads; showing it re-registers the watchers and reloads loaded directories once.
- **preview/** - auto-detected dev-server preview tab (status-bar pill suggests opening when a localhost URL is detected).
- **tabs/** - `useTabs` is the source of truth for tab list + active id. `useWorkspaceCwd` derives explorer root + inherited cwd for new tabs from active tab. `basename` splits on both `/` and `\`.
- **header/** - top bar + inline search (`SearchInline` adapts to terminal vs editor via `SearchTarget`). `WindowControls` rendered when `USE_CUSTOM_WINDOW_CONTROLS` is true (Linux + Windows; macOS uses native traffic lights).
- **statusbar/** - bottom bar, `CwdBreadcrumb` (handles Unix paths, Windows drive letters, and home `~` segments via `pathUtils.segmentsFromCwd`), AI tools indicator.
- **shortcuts/** - keymap registry (`shortcuts.ts`) + `useGlobalShortcuts`. Handlers live in `App.tsx` and are passed in by id (`tab.new`, `ai.toggle`, …). `metaKey || ctrlKey` for cross-platform Cmd/Ctrl.
- **settings/** - settings store (`store.ts` via `tauri-plugin-store`), preferences hook, settings window opener. The Settings window is closed (not hidden, so its WebContent process is released) when it hands a theme edit to the main window; `open_settings_window` rebuilds it on demand.
- **sidebar/** - activity bar + collapsible side panels (explorer, source control, git history).
- **source-control/** - git status / stage / commit panel and diff workflow. `useSourceControl` takes a `live` flag (`statusConsumers.ts`): `git status` runs on window focus and context changes only while the Source Control panel, a git tab or the explorer's git decorations are on screen. Otherwise nothing runs, a snapshot for another repository is dropped (never a wrong badge), and the next consumer to appear refreshes it. The rail badge alone is not a consumer; it refreshes lazily.
- **git-history/** - commit graph rail, refs, per-commit file diffs.
- **lsp/** - opt-in language server support, zero cost until enabled (no process, no PATH check, nothing in the eager bundle beyond a 14.5 kB shell). Statusbar pill offers Enable (binary found) or Install (with copyable command) per language; activation persists as `lspActivation` in the settings store (`enabled`/`dismissed`/unset). `sessionManager.ts` keys sessions by (server, workspace root), refcounts open docs, idle-kills after 3 min, and crash-backoffs (cooldown before respawn; 3 in 5 min → give up + toast with the server's stderr tail). Resource invariants: **no root marker → no session** (a dirname fallback once spawned a server per directory and burned GBs), hard cap of 4 sessions per server, lean per-preset `initializationOptions` (rust-analyzer: `cachePriming` off + bounded `lru`; tsls: `maxTsServerMemory`). Client is `codemirror-languageserver` behind a lazy import, subclassed (`lib/client.ts`) to add didClose/didSave/shutdown, `textDocument/references` (Shift-F12; multi-result definitions and references share the `locationsPanel.ts` picker) and the publishDiagnostics capability the lib forgets (tsls sends no diagnostics without it); `lib/transport.ts` bridges to the Rust pipe and answers server-to-client requests the lib ignores. `vscode-languageserver-protocol` is aliased to a 4-enum shim in vite.config.ts (~117 kB saved). Presets: typescript, rust-analyzer, pyright, ruff, gopls and more; custom stdio servers via Settings. Several presets can claim one language (pyright and ruff both take `py`): `serverForLanguage` prefers the enabled candidate, so enabling ruff while pyright is unset or dismissed routes Python to ruff. WSL workspaces excluded for now.
- **markdown/** - markdown preview renderer (backs the `markdown` tab kind).
- **workspace/** - workspace environment switching (Local + WSL distros).
- **theme/** - custom theme engine (no `next-themes`). `ThemeProvider` + `applyTheme` write CSS variables; built-in presets in `themes/` (terax-default - colours live in `globals.css` since ThemeProvider clears rather than applies for that id - xcode, claude, kanagawa, kanagawa-dragon, tokyo-night, catppuccin, rose-pine, everforest, nord, gruvbox, dracula, solarized, tide, sage, caffeine), each optionally declaring an `editorTheme` pairing consumed by `resolveEditorThemeId` (see editor/). User themes via `customThemes.ts` + `validateTheme.ts`, optional background image via `bgImageStore.ts` + `SurfaceLayer`.
- **updater/** - auto-updater UI built on `tauri-plugin-updater`.
- **agents/** - agent launching, notifications, and management for both the built-in Terax agent and terminal coding agents (Claude Code, Codex, Gemini CLI, Pi, OpenCode, Grok). The header launcher (`components/AgentLauncherPanel.tsx` + `lib/launcher.ts`) persists per-agent start commands in preferences and atomically builds balanced one-to-four-pane tabs. Shared store (`store/agentStore.ts`: terminal `sessions` + `localAgent` + `notifications`) and a shared router (`lib/route.ts`: suppress when focused-and-visible, OS-notify when unfocused, in-app Sonner toast when focused-but-hidden) feed the header `NotificationBell` (management surface, Terax agent listed first, per-agent hook enable rows). Toasts use Sonner (`components/ui/sonner.tsx`) themed via the central engine; `lib/agentIcon.tsx` renders the per-agent brand mark. Terminal detection is Rust-side (`pty/agent_detect.rs`) on the PTY reader's byte filter, armed on `OSC 133;C;<cmd>` or self-armed by the marker, emitting `terax:agent-signal` transitions (`started`/`working`/`attention`/`finished`/`exited`) driven only by OSC sequences (never raw output, so a repainting TUI never flaps) - zero cost when no agent runs. Hook-backed terminal agents converge on the same `OSC 777` marker the detector reads, installed via `agent_enable_hooks(agent)` / `agent_hooks_status(agent)` in `modules/agent.rs` (data-driven `AgentSpec` for JSON-hook agents plus a Terax-owned Pi extension; atomic writes, foreign configuration preserved, idempotent; gated on `TERAX_TERMINAL`). OpenCode and Grok use OSC 133 process-lifecycle detection but do not install attention hooks. Delivery differs because only Claude's hook protocol can return terminal bytes in the hook *response*: **Claude** (`~/.claude/settings.json`, `UserPromptSubmit`/`Notification`/`Stop`) returns the marker via the `terminalSequence` field (legacy 3-field `notify;Terax;<event>`). **Codex** (`~/.codex/hooks.json`, `UserPromptSubmit`/`PermissionRequest`/`Stop`) and **Gemini** (`~/.gemini/settings.json`, `BeforeAgent`/`Notification`/`AfterAgent`, `matcher:"*"`) can't, so the hook *command* emits the 4-field `notify;Terax;<agent>;<event>` marker itself (`printf > /dev/tty` on Unix, or `terax __terax_notify` writing to `CONOUT$` after `AttachConsole` on Windows) and prints `{}` as a JSON stdout no-op (Codex's `Stop` and Gemini both reject empty/non-JSON stdout). **Pi** (`~/.pi/agent/extensions/terax-notifications.ts`) uses `agent_start`/`agent_settled` extension events and writes its named marker directly to stdout. The agent-named marker lets a self-arm name the right agent when no preexec fired (bash/tmux/Windows). The Terax agent path is `ai/components/LocalAgentNotificationsBridge.tsx`, mapping `chatStore.agentMeta` (`awaiting-approval`→attention, busy→idle→finished, `error`) into the same router.
- **command-palette/** - modal command palette (`CommandPalette.tsx`, `commands.ts`) for actions and navigation.
- **spaces/** - workspace spaces/projects (name, root, env, color, per-space tab persistence) via `useSpaces` and `SpaceSwitcher`.
- **ai/** - see below.

### AI subsystem (`src/modules/ai/`)

BYOK. Cloud providers via `@ai-sdk/*`: **OpenAI, Anthropic, Google, xAI, Cerebras, Groq, DeepSeek, Mistral, OpenRouter**, plus **OpenAI-compatible** for any custom base URL. Local / offline providers (key-optional, model id supplied at runtime): **LM Studio, MLX, Ollama**. Provider list in `config.ts` (`PROVIDERS`); model registry includes `DEFAULT_MODEL_ID` + `DEFAULT_AUTOCOMPLETE_MODEL`.

- **Key storage**: OS keychain via `keyring` (Rust). Frontend reads/writes through `secrets_*` commands. Service `KEYRING_SERVICE = "terax-ai"`. Never persist keys to disk, settings store, or `localStorage`.
- **Agent** (`lib/agent.ts`): `Experimental_Agent` with `stopWhen: stepCountIs(MAX_AGENT_STEPS)` and the system prompt from `config.ts`. Provider branching happens here - keep the `Agent` / `DirectChatTransport` shape; the rest of the system depends on AI SDK v6 chat semantics.
- **Sub-agents** (`agents/registry.ts`, `agents/runSubagent.ts`): named sub-agents with their own system prompts and tool subsets, invoked by the main agent via `run_subagent` tool.
- **Sessions** (`lib/sessions.ts` + `store/chatStore.ts`): conversations are organized into named sessions. `terax-ai-sessions.json` retains only metadata and `activeId`; message arrays live in atomically replaced `conversations/session-<id>.json` files owned by Rust. Messages cross IPC as raw JSON bytes (validated by a streaming pass, never rebuilt as a document tree); every save flushes the new file (plain `fsync`) before the rename and keeps the replaced version as `session-<id>.json.bak`; mid-stream saves are scheduled at most every 2 s and at least every 4 s, while turn end, session switch and window close save durably (full flush, `F_FULLFSYNC` on Apple, plus a directory sync). A queued write for a session is replaced by a newer one, and a damaged file is set aside as `session-<id>.json.corrupt` and the load falls back to the `.bak` before the conversation reads as empty, so one bad conversation never breaks the rest. Legacy migration is per session: it removes a legacy key only after its message file is safe, never overwrites a newer file on retry, skips and reports a failing key, and deletes `terax-ai-sessions.before-message-files.json` once every conversation that copy holds, not only the ids the caller lists, reads back as a valid file (a leftover copy older than seven days with nothing to migrate is pruned at startup, and deleting a session scrubs it from the copy). Window close flushes with a timeout and never traps: a failed flush shows a "Close anyway" error once. Per-session queues and a native I/O gate serialize storage operations across page reloads; failed latest writes remain retryable, and window close flushes pending storage. `chatStore.ts` keeps a module-scoped `Map<sessionId, Chat<UIMessage>>`; `getOrCreateChat(sessionId)` lazily constructs a `Chat`, seeded with messages from a hydration map populated by `hydrateSessions()` (called once from `App.tsx`). `AgentRunBridge` mirrors active-session messages to disk on every change and auto-derives titles from the first user message. Switching the API key wipes the chat map; sessions persist.
- **Composer** (`lib/composer.tsx`): React context providing shared input state (text, attachments, voice) for both the docked `AiInputBar` and any other surface. Attachments include image, text-file, and `selection` kinds - selections come from `useChatStore.attachSelection(text, source)` (drained into chips, not pasted into the textarea) and are wrapped as `<selection source="terminal|editor">…</selection>` blocks at submit. Composer derives `isBusy` from `agentMeta.status` so it can mount safely before sessions hydrate.
- **AI HTTP transport**: binary request bodies and response packets avoid JSON byte arrays. Native requests are owned by their calling window, explicitly cancelled on abort, page reload, or window destruction, and bounded to 16 concurrent requests. A 128 KiB byte window (at most 256 packets) carries at most 64 KiB per packet and coalesces ready network chunks; the webview acknowledges validated cumulative byte boundaries once half a window has arrived, so small SSE chunks cost no per-chunk IPC, and a consumer that grants no credit for two minutes is abandoned and its request cancelled. The frontend consumer queue is capped at 192 KiB, request bodies at 64 MiB, and request metadata at 64 KiB. Consumer cancellation during startup is repeated after native registration completes. SSRF validation and DNS pinning remain in Rust.
- **Voice input**: streamed transcription pipeline. Toggled from the composer.
- **Live context bridge**: `App.tsx` calls `setLive({ getCwd, getTerminalContext, … })` so tools can read the *currently active* terminal's cwd + last 300 lines of buffer. Lazy by design - don't pre-snapshot.

- **AI review, Antigravity-style (fork, Fase 1-8)**: after a task finishes, the
  chat shows a `ChangedFilesCard` (`src/modules/ai/components/ChangedFilesCard.tsx`)
  listing every file the agent changed, with +added/-removed counts
  (shared `computeLineStats` in `src/modules/editor/lib/diffStats.ts`) and a
  per-file review status (`AiDiffStatus` in `src/modules/tabs/lib/useTabs.ts`:
  pending, reviewing, done, applied, rejected, conflict, restored; labels in
  `src/modules/tabs/lib/aiDiffStatus.ts`). Clicking Review on a file opens
  the file in the editor at its first undecided hunk when inline review is
  on, or activates its ai-diff tab when it is off. The card derives its data
  with the shared `extractFileMutation` / `deriveProposed` in
  `src/modules/ai/lib/fileMutations.ts`, the same functions `AgentRunBridge`
  uses to open the tab. Per-hunk review (Fase 2, rebuilt
  Fase 4): the proposal is broken into hunks
  (`src/modules/editor/lib/lineDiff.ts`: `computeLineChanges`,
  `reconstructFileFromHunks`, `countHunkDecisions`,
  `hunkDecisionsToLineDecisions`, `migrateLineDecisionsToHunks`); each hunk
  is decided Accept/Reject, per hunk or per file (Accept all / Reject all /
  Reject remaining); decisions live on the tab (`AiDiffTab.hunkDecisions`,
  `setAiDiffHunkDecision`) because the pane unmounts on tab switch.
  Decisions are undoable (Ctrl+Z) and redoable (Ctrl+Y) per proposal
  (`src/modules/ai/lib/reviewHistory.ts`, one stack per approval id, shared
  by the pane and the inline editor, cleared on confirm/discard). Confirm is
  enabled only when every hunk is decided (Fase 8, write-first): the agent
  already wrote the change, so Confirm only decides what stays — Accept is
  bookkeeping only and writes nothing, Reject reverts the rejected hunks
  from the checkpoint via `confirmReviewedEdit`
  (`src/modules/ai/lib/reviewApply.ts`). It guards the revert with a djb2
  hash of the on-disk content vs the *written* content `proposedContent`
  (mismatch sets the tab `conflict` and blocks the confirm; "Check again"
  re-runs the guard, "Discard proposal" drops the proposal without touching
  the disk), and writes the reconstruction atomically through
  `native.writeFile` when any hunk was rejected. A read-only result preview
  shows the reconstruction side by side with the diff, decided hunks highlighted.
  `confirm_reviewed_edit` is deliberately not an AI SDK tool: only the review
  UI may invoke it, never the model. Proposals recorded before Fase 8
  (tab `written: false`) still use the old path: Apply writes the
  reconstruction via `applyReviewedEdit`, guarded against the original
  content instead.
  Fase 3: (FR-09) the "New file" badge is the same chip in the chat card and
  the diff header. (FR-10) open proposals survive a restart: `src/modules/ai/lib/reviewPersistence.ts`
  (`snapshotReviewState` / `parseReviewState`, versioned format v3, v1 line
  decisions migrated to hunks on restore, v2 states migrate to v3) stores
  only status + hunk decisions per session in the same LazyStore as the
  session metadata (`review:<id>` in `lib/sessions.ts`, saved debounced from
  `App.tsx`, deleted with the session); the reviewed contents come from the
  persisted checkpoint when the agent already wrote (Fase 8), or are
  re-derived from the chat messages by `AgentRunBridge` on reopen for
  legacy proposals, which restores the saved status/decisions into
  `openAiDiffTab` and toasts once per session when proposals were restored. (FR-11) Settings → General → "Review AI edits
  inline in the editor" (`aiReviewInline`, default on, in
  `src/modules/settings/store.ts`, following `antigravity.enableInlineDiff`;
  a stored Fase 3 `aiReviewPerLine` choice migrates to it); keyboard
  navigation in the review list (`src/modules/editor/lib/reviewKeyboard.ts`:
  ArrowUp/ArrowDown move between hunks, Alt+Enter accept, Alt+Shift+Enter
  reject, Ctrl+Z undo, Ctrl+Y redo, clamped at the ends) is scoped to the
  review list container only, so it never fires while typing in the
  composer, editor, or terminal.
  Fase 4 (inline review): with `aiReviewInline` on, the change also
  renders inline in the open editor
  (`src/modules/editor/lib/inlineReview.ts`: a CodeMirror extension over
  the agent-written buffer — added lines are real buffer lines, green
  while undecided and struck through once rejected; removed lines show
  as a widget with the original text, struck through while undecided and
  hidden once accepted — with an Accept/Reject header above each hunk;
  the ai-diff tab stays as the side-by-side alternative). `EditorPane`
  wires the extension to the proposal for its file
  (`src/modules/editor/lib/reviewTab.ts` matches the first ai-diff tab
  by path, edit proposals only) and focuses the first undecided hunk the first time the editor
  becomes visible with a pending proposal. `AgentRunBridge` opens ai-diff
  tabs in the background while inline is on (`openAiDiffTab` takes
  `activate: false`). Ctrl+Z in the editor stays text undo on purpose:
  review undo lives in the ai-diff pane only. The editor stays editable
  during review (the old "read-only during review" claim was wrong and
  is corrected in Fase 8): a mid-review edit to the buffer blocks the
  confirm through the disk guard instead of being silently overwritten,
  and the save path has its own mtime guard (`useDocument`: saving a
  buffer whose file changed on disk is withheld with a toast until the
  user explicitly overwrites). Known limits: only the first
  proposal per file shows inline; editing the buffer mid-review leaves the
  decorations mapped through the edits (approximately right, the ai-diff
  tab stays authoritative).
  Fase 5 (checkpoint/undo and delete/rename review): every agent write
  saves a checkpoint first — since Fase 8 at write time, not at Apply
  (`src/modules/ai/lib/reviewCheckpoint.ts`:
  pre-write content + hash + time + approval id + accepted hunks, one per
  file per proposal, at most 20 per session, oldest dropped;
  `ensureWriteCheckpoint` advances only the written state on a composed
  write, never the baseline). A confirmed file can be
  restored from the Changed Files card and from the ai-diff tab ("Restore" /
  "Undo confirm", atomic re-write through the same `native.writeFile` path);
  after restore the status is `restored`. The restore guard refuses when
  the disk no longer matches the confirmed result, so a later manual edit is
  never silently overwritten; "Restore anyway" is an explicit second action
  with confirmation, available in the ai-diff tab only. Checkpoints ride
  the v3 review persistence (a confirmed proposal is only restorable with a
  checkpoint) and are cleared with the session, in memory and on disk.
  The agent can now delete and rename files (`delete_file`,
  `rename_file` in `src/modules/ai/tools/fs.ts`): since Fase 8 they
  execute immediately, like edits, and are reviewed afterwards in the
  ai-diff tab (`AiDiffTab.mutationKind`, `targetPath`, `fileDecision`)
  with a Deleted / Renamed chip in the card
  and the tab header. Delete needs a prior `read_file` and refuses when
  the content changed since that read; rename refuses an existing target
  and a target outside the workspace root (shared pure guards in
  `src/modules/ai/lib/fileOpGuards.ts`, also used by the tools). Confirm
  only verifies the executed operation still holds
  (`confirmReviewedDelete` / `confirmReviewedRename` in `reviewApply.ts`);
  Reject restores from the checkpoint, so a deleted file is recreated and
  a renamed file is moved back. Plan mode refuses both tools (never queued as writes).
  If the agent deletes or renames through the shell (`run_command`), that
  is caught by the destructive-shell guard (see "Bug-fix batch" below):
  broad targets are refused outright, scoped deletes show an explicit
  warning on the approval card. A file deleted on disk while a proposal
  is pending is caught by the FR-07 conflict guard. Delete/rename
  proposals never render inline in the editor.
  Click fix (after Fase 5): a click on a Changed Files row never does
  nothing. The ai-diff tab is created by `AgentRunBridge` after the
  proposal lands, while the row already appears from the message parts,
  so a click while the agent is still working used to return silently.
  Now the row passes its resolved absolute path to `handleOpenFileDiff`
  (`src/app/App.tsx`), which decides through the pure helper
  `decideOpenFileDiff` (`src/modules/tabs/lib/openFileDiffAction.ts`):
  tab exists + inline on + edit opens the file in the editor; otherwise
  it activates the ai-diff tab; no tab yet opens the file in the editor
  and toasts honestly that the review is not ready yet (inline
  decorations sync from the ai-diff tab, so without a tab there is
  nothing to decorate); a failed activation toasts an error. Known
  limit: clicking while the agent is still working opens the file in the
  editor, but the review decorations only appear once the ai-diff tab
  has been created; click the row again after the agent finishes.
  (Since Fase 7 the card itself is hidden mid-run, so this limit is
  rarely reachable any more — the fallback stays for the race where the
  tab does not exist yet right as the run ends.)
  Fase 6 (Antigravity approval model): there is no approval card for file
  edits any more. `edit`, `multi_edit`, `write_file`, `delete_file` and
  `rename_file` are write-first tools since Fase 8
  (`src/modules/ai/tools/edit.ts`, `fs.ts`): they write to disk
  immediately (Fase 6 had them proposal-only — that model is superseded,
  see Fase 8), and the agent run continues to the next todo without waiting.
  `AgentRunBridge` opens an ai-diff tab from each finished file-mutation
  tool call (`src/modules/ai/lib/fileProposals.ts` collects them from the
  message parts; `updateAiDiffTab` in `src/modules/tabs/lib/aiDiffUpdate.ts`
  composes sequential proposals to the same file into one pending tab).
  Sequential proposals compose through a per-session registry
  (`src/modules/ai/lib/pendingProposals.ts`: original content is the disk
  content at the first write, proposed content is the latest written
  content; cleared on Confirm/Discard and on session change, never
  touched in plan mode).
  The permission card survives only for terminal commands (`bash_run`,
  `bash_background`, `spawn_coding_agent`, `send_to_agent`), which still
  pause the run until answered; `AiToolApproval.tsx` covers only those.
  Review happens once at the end, from the Changed Files card, exactly as
  before (per-hunk Accept/Reject inline or in the ai-diff tab, Confirm with
  checkpoint, Restore). The old "Approve on the composer card writes the
  whole file without checkpoint" gap is gone for edits because that card
  no longer exists for them. The `approvalId` field name is legacy: it now
  holds a tool-call id (the same value threads tabs, persistence,
  checkpoints and the card) to avoid a repo-wide rename. Known limits:
  if the user starts reviewing a tab mid-run (status leaves `pending`), a
  later proposal to the same file opens a separate tab instead of
  composing, and at most one of the two can Confirm cleanly (conflict
  guard); on session restore the registry is empty, so multiple parts for
  one file open separate tabs (pre-existing behaviour) while the card
  still shows one row per file.
  Fase 7 (Changed Files card only after the run ends): the card is gated
  on the run that produced the message (`shouldShowChangesCard` in
  `src/modules/ai/lib/changesCardVisibility.ts`, used in
  `RenderedMessage` in `AiChat.tsx`). While the message is still
  streaming, or while it holds a part waiting on a terminal-command
  approval (`state === "approval-requested"` — the approval wait needs
  its own check because the stream has ended by then, so the chat status
  is "ready" while the run is still waiting on the user), the card is
  not rendered at all: no file list, no "Perlu review" badge. It appears
  once the run is over — finished, errored, stopped, or cut off by the
  step cap — and for reviews restored from a previous session, which
  were over long ago. The gate is per-message, so an older turn's card
  stays visible while the agent works on a new task. What is gated is
  only the card: `AgentRunBridge` still opens the ai-diff tabs in the
  background as proposals arrive (activate: false when inline review is
  on), because the inline decorations sync from the first ai-diff tab
  per path — delaying the tabs would break inline review when the card
  finally appears, and background tabs never steal focus. The click
  behaviour from the click fix is unchanged. Known corner, kept on
  purpose: if the user stops the run while a bash approval is still
  outstanding, the `approval-requested` part stays in the message, so
  the card stays hidden until the approval is answered (Approve/Deny
  lets the run conclude and the card appears); the proposals are not
  lost — the ai-diff tabs exist and the approval card stays visible.
  Fase 8 (write-first, Antigravity Turbo model): the proposal-only design
  of Fase 2/6 is gone. The agent's file tools write to disk immediately
  — git shows the change as soon as the task finishes, and later
  terminal commands (build, test) run against the new code. The review
  flips with it: the diff is checkpoint (before) vs disk (now), Accept is
  bookkeeping only (the hunk is marked done, nothing is written), Reject
  reverts the hunk from the checkpoint, and the pane's action is called
  Confirm (all-rejected: "Revert all"), not Apply. The checkpoint is
  taken at write time by the file tools themselves (Fase 9:
  `recordToolWriteCheckpoint` in `src/modules/ai/lib/reviewCheckpoint.ts`,
  called from `tools/edit.ts` and `tools/fs.ts` with the tool call id as
  the checkpoint id) — the bridge's later `ensureWriteCheckpoint` for the
  same id only advances the written state, so the one-effect window
  between write and checkpoint is closed: Restore works even if the run
  is interrupted before the bridge opens the tab. The baseline never
  advances mid-run: sequential writes to the same file
  compose against the first write's baseline, so Reject always reverts to
  the original file, never to an intermediate write
  (`ensureWriteCheckpoint` / `updateCheckpointAfter` in
  `src/modules/ai/lib/reviewCheckpoint.ts`). Delete/rename also execute
  immediately, with a checkpoint, so Reject restores the file / renames
  it back. The tab carries a `written` flag (`AiDiffTab.written`):
  write-first tabs confirm, pre-Fase-8 tabs (restored from an older
  session, no checkpoint) still apply through the legacy
  `applyReviewed*` path. The Changed Files card stats read the same
  written baseline (registry, then checkpoint, then legacy derivation).
  Plan mode still never writes. Known limits: the
  checkpoint still stores full file contents, so very large files cost
  memory and session-state size; if the user has unsaved edits in the
  editor when the agent writes the same file, the buffer is not reloaded
  (dirty guard) and a later save is withheld by the mtime guard until
  the user explicitly overwrites — the review tab still shows the
  agent's baseline, and Reject would restore it, discarding the unsaved
  edits. Still no plan review, no browser/live preview, no automatic
  build/test verification after Confirm.
  Fase 9 (interrupted runs + card at the end of the message): a run
  that dies mid-task (connection lost, user Stop, provider error) used
  to leave no trace — the next run read the previous summary as fact,
  claimed the work done without a single tool call, and the todos sat
  at 0/4 with a spinner as if still running. Three layers now. (1)
  The outcome of every run is recorded (`agentMeta.lastRunOutcome` in
  `src/modules/ai/store/chatStore.ts`, from the AI SDK Chat `onFinish`
  callback wired in `chatRuntime.ts`: `isAbort` → stopped,
  `isDisconnect` → interrupted, `isError` → error, else finished), and
  a todo left `in_progress` by an abnormally-ended run is reverted to
  `pending` (`revertInProgressTodos` in
  `src/modules/ai/lib/todos.ts`) — approval pauses end with outcome
  "finished", so waiting on the user never reverts a todo. (2) On
  resume in the same session, the transport prepends a `<previous-run>`
  block to the next user message (`buildResumeReminder` in
  `src/modules/ai/lib/resumeReminder.ts`, wired through
  `createContextAwareTransport`): the old summary is not proof, verify
  against disk, finish the open todos; nothing is injected after a
  clean finish, and the injected copy is run-only, never persisted.
  Tool calls that never returned a result are dropped from history
  (`convertToModelMessages` with `ignoreIncompleteToolCalls` in
  `src/modules/ai/lib/agent.ts`) instead of being sent as assistant
  `tool_calls` with no `tool-result`. The system prompt no longer
  claims changes are "not on disk yet" (proposal-only leftover) and
  carries a verify-before-done rule in both the full and lite prompts
  (`src/modules/ai/config.ts`). (3) The UI says so plainly: the
  "Terax finished" toast only fires when the recorded outcome is
  finished (Stop no longer earns it,
  `LocalAgentNotificationsBridge.tsx`), and the chat shows an
  interrupted-run notice row whenever a run ends with open todos —
  "Run terputus karena koneksi — N todo belum selesai" (or "Agent
  menyatakan selesai, tapi N todo masih terbuka" after a clean finish
  with work remaining) — with a Lanjutkan button that resumes with a
  verify-first instruction. The Changed Files card also moved: the
  `"changes"` group is now emitted last in `buildPartGroups`
  (`src/modules/ai/lib/partGroups.ts`), so the card renders at the end
  of the assistant message, below the summary text, like the Todos
  block; the Fase 7 gating (hidden while streaming / awaiting a bash
  approval) is unchanged, only the position. The bridge no longer
  strands proposals when its effect is cancelled mid-await
  (`BridgeProposalTracker` in
  `src/modules/ai/lib/fileMutationBridge.ts` — a cancelled run leaves
  the fingerprint undone and requests a retry, unmarking proposals it
  marked but never finished), and checkpoints are persisted even when
  no ai-diff tab is open (`snapshotReviewState` synthesizes
  checkpoint-only proposals, `src/modules/ai/lib/reviewPersistence.ts`;
  the App persist effect no longer returns early with zero tabs), so a
  crash before the first tab no longer loses Restore. Known limits,
  kept deliberately: no timeout anywhere (a stalled connection hangs
  in `streaming` — no chunk-timeout in `streamText`, `proxyFetch`, or
  the Rust stream); a bash approval still hangs forever and Stop is a
  no-op while one is outstanding; the 20-checkpoint-per-session cap
  still silently drops the oldest; a second write after review started
  still opens a second tab; the restore fallback for pre-Fase-8 edits
  without a checkpoint still derives from disk (wrong for write-first
  edits, which is why the tool-side checkpoint exists); local tool
  execution still cannot be cancelled by Stop or a dropped connection
  (the write already happened, only its result is discarded).
  Fase 10 (ESLint diagnostics, Antigravity-style): open JavaScript/TypeScript
  files are linted with the project's own ESLint install and config, never a
  bundled copy (`src/modules/eslint/`). Detection walks up from the file to
  `node_modules/.bin/eslint` (or `eslint.cmd` on Windows), falling back to
  `npx --no-install eslint`; nothing is installed into the project. Runs go
  through the existing one-shot `shell_run_command` (`--format json`,
  30 s timeout; exit 1 means violations found, exit 2
  with a config error means the project has no usable config). Results are
  mapped to CodeMirror diagnostics (`eslintMessagesToDiagnostics` in
  `lib/eslintJson.ts`: 1-based positions clamped to the document, severity
  2 is error, 1 is warning, rule id in the message) and published into the
  shared lint state merged with the LSP diagnostics (`mergeDiagnostics` in
  `lib/eslintMerge.ts`, ESLint entries tagged `source: "eslint"`): the LSP
  plugin publishes with setDiagnostics, which replaces the whole set, so a
  merge guard re-applies the stored ESLint diagnostics whenever another
  publisher wipes them. The existing `diagnosticsReporter` counts the
  merged set, so the status bar badge and the explorer row counts
  (`DiagnosticsMark` in `src/modules/explorer/`, folders aggregate their
  subtree) update with no extra wiring. Triggers are open, save
  (`requestEslintRun` from `EditorPane.performSave`) and external reload
  (agent write), debounced (600 ms) with a generation guard that drops
  stale runs. A run is skipped while the buffer is dirty: ESLint lints
  the file on disk, so diagnostics always describe the saved file.
  "Dirty" is judged after LF normalization (`diskTextMatchesBuffer` in
  `src/modules/editor/lib/eol.ts`): buffers live in LF space, so a saved
  CRLF file matches its buffer. Before this fix the check compared raw
  bytes, which silently skipped every CRLF file forever — no
  diagnostics, no toast (reported against a Next.js project with
  ESLint 8.57.0, `@typescript-eslint/no-unused-vars: error`).
  Settings → General → "ESLint diagnostics" (`eslintEnabled` in
  `src/modules/settings/store.ts`, default on). When the project has no
  ESLint or no config, a warning toast appears once per root per session
  instead of failing silently; a timed-out or failed run now warns the
  same way (`notifyEslintRunFailed`). Known limits: diagnostics cover the saved
  file only, never unsaved typing; badges appear only for open files
  (the LSP has the same limit); a very dirty file can exceed the 256 KiB
  one-shot output cap and report a failure; a global eslint is used only
  through npx without install.
  Fase 10.1 (diagnostic build): every run exit now records a per-path
  run status (`runStatus` in `src/modules/eslint/lib/eslintStore.ts`,
  text in `lib/eslintStatusText.ts`) shown as a pill in the status bar
  next to the diagnostics badge, with a popover explaining the outcome
  and a "Jalankan ulang" button. Command Palette → "Run ESLint on
  current file" (Editor group) forces a run past the debounce and
  toasts the outcome — counts on success, the exact reason on
  failure. The exits that used to be silent now toast once per root
  per session: disk read failed, and ESLint returning results for a
  different path (the toast names both paths). A dirty buffer skip
  and a doc-changed abort record status only, never a toast, because
  both are normal while typing or saving. A binary-detection miss
  carries a diagnosis — how many ancestor levels were walked,
  whether the 12-level cap was hit, and whether `fs_stat` failed on
  the file's own directory (control probe) — so "path too deep" can
  be told apart from "fs_stat cannot see this project" and "no
  eslint installed". Build identity: the short git commit is baked
  in at build time (`__TERAX_COMMIT__` via vite `define`) and shown
  in Settings → About ("Commit"); the app version stays 0.9.0 across
  fork phases. Eager entry points (App, StatusBar) must import the
  pill and the manual-run helper from their direct paths, never the
  eslint barrel — the barrel also exports the CodeMirror-backed
  plugin, and importing it pulls CodeMirror into the startup chunk
  (caught by the dist-budget/eager-budget tests).
  This phase was built because a user install showed
  neither diagnostics nor any toast after the CRLF fix (ESLint 8.57.0
  flags the file manually), and none of the silent exits could be
  localized from the laptop alone.
  Fase 10.2 (manual-run path matching): running "Run ESLint on
  current file" from the Command Palette toasted "Tidak ada editor
  ESLint untuk file ini" even though the .tsx file was open. The
  cause, traced from the code rather than guessed: the plugin — and
  therefore the run listener — only exists while the document is
  "ready" (`useEslintExtension(path, doc.status)`), so a file still
  loading from disk (or unreadable) leaves the enabled command with
  no listener and a misleading toast. For a plain editor tab the
  subscribe and lookup keys were already the same string
  (`tab.path`), so a separator/case mismatch between those two was
  ruled out; the real holes were the not-ready window, git-diff /
  git-commit-file tabs (enabled with a constructed lintable path but
  no editor at all), and ai-diff tabs (disabled with the wrong
  "No file open" reason). The fix: `eslintPathKey` in
  `lib/eslintPaths.ts` (forward slashes, lowercased on Windows, where
  the filesystem is case-insensitive) is now the single map-key form
  for the listener registry (`lib/eslintRequests.ts`), the store's
  `byPath`/`runStatus` keys (normalized in the setters; readers in
  the plugin, the manual helper, and the status pill look up by the
  same key), and the hook records editor presence
  (`loading`/`ready`/`unavailable`) so the manual-run toast names
  the real cause — still loading, plugin still attaching, file
  unreadable, or no editor tab at all (review/diff tabs named
  explicitly). The palette command is now disabled with the correct
  reason on ai-diff ("Buka file di tab editor, bukan tab review")
  and git-diff/git-commit-file tabs ("…bukan tab diff").
  Fase 10.3 (ESLint result matching): `findResultForFile` in
  `lib/eslintJson.ts` now compares with the same canonical key as the
  rest of the ESLint chain (`eslintPathKey` — forward slashes,
  lowercased on Windows), so an ESLint-returned path differing only in
  casing (drive letter, a segment) still matches and a successful run
  can no longer end in a silent "no-result-match" with zero
  diagnostics. The `no-result-match` detail text no longer blames case
  on Windows; symlink / 8.3 short-name mismatches remain possible.
  Fase 11 (project-wide lint, Problems panel): per-file lint only
  covers opened files, so Command Palette now has "Run ESLint on
  entire project" (Editor group, `lib/runEslintProject.ts`). It runs
  `eslint .` from the binary root with the same walk-up binary
  resolution as the per-file runs (`resolveEslintBinary` from a path
  inside the root; a binary found in an ancestor lints that
  ancestor), a 120 s timeout (`PROJECT_LINT_TIMEOUT_SECS` in
  `lib/eslintRunner.ts`), and the same output interpreter as
  `runEslintFile`, except a truncated run is its own outcome: the
  256 KiB one-shot cap can cut a project-wide JSON report short, and
  the panel then says the results are incomplete instead of showing a
  partial list as complete. One run at a time (a second invocation
  toasts "still running"); the run is async and never blocks the
  editor, and a stale completion is dropped when a newer run started.
  Results land in `projectLint` in `lib/eslintStore.ts` and render in
  the sidebar "Problems" view (`components/ProblemsPanel.tsx`,
  rail badge is the error total), grouped by file, sorted by
  canonical path then line, each row opening the file at the reported
  1-based line through the existing `openContentHit` path. The panel
  is a snapshot: it survives closing the view, goes stale when files
  change or the root changes (the panel says so and offers a re-run),
  and is replaced only by the next run. The run also fills the
  explorer counts (`diagnosticsStore`) for files that are not open,
  so unopened files show their badge; open files keep their per-file
  counts, and the editor unmount cleanup restores the project counts
  for a closed file instead of wiping them. Files fixed since the
  last run lose their badge on the next run. The command is disabled
  only when ESLint is off or no project is open; a missing binary is
  not a palette-time disabled reason (the stored rootStatus keys do
  not share one form with the explorer root) and the run toasts the
  honest cause instead, reusing the Fase 10.1 missing-binary text.
  Fase 12 (ESLint as a language server, the VS Code way), DONE,
  plan verified live against the real server before any code was
  written (harness in /tmp, not in the repo), then implemented: the CLI-spawn integration of
  Fase 10–11 is tied to the editor document lifecycle, the plugin
  only exists while `docStatus === "ready"`, so a file whose document
  never finishes loading (the user's OneDrive CJK path) never gets
  diagnostics and the manual command fails. VS Code/Antigravity run
  ESLint as a background language server independent of the editor.
  Three open questions, answered empirically against
  `vscode-langservers-extracted@4.10.0` + ESLint 8.57.0 +
  `.eslintrc.json` (legacy) + `@typescript-eslint/no-unused-vars`,
  driven by a JSON-RPC harness that mimics Terax's client:
  (1) initializationOptions / workspace/configuration, the server
  ignores `initializationOptions` entirely, but calls
  `workspace/configuration` (`{scopeUri, section: ''}`) on every
  settings resolution. Terax's transport answers that with `[null]`
  per item (`answerServerRequest` in `lib/transport.ts`), and the
  live test proves that crashes the server: `null` fails the pull
  with `-32603 Cannot read properties of null (reading
  'workingDirectory')`; `{}` fails at `path.isAbsolute(undefined)`
  (`nodePath`) and at `settings.problems` being undefined. A
  VS-Code-defaults-shaped answer works: `validate: 'probe'`,
  `packageManager: 'npm'`, `nodePath: null` (must be null, not
  undefined, the server's `!== null` check), `useFlatConfig: null`,
  `experimental: {}`, `options: {}`, `run: 'onType'`,
  `problems: { shortenToSingleLine: false }`,
  `rulesCustomizations: []`. The server then loads the project's own
  ESLint and validates. The answer lives in the transport (it already
  intercepts server-to-client requests there), keyed per server via
  the preset's `workspaceConfiguration`, so other servers keep the
  current null answers. `workspace/diagnostic/refresh` is answered
  with null (currently -32601); the pull layer re-pulls on doc change
  and save, so the refresh is only a hint and needs no handler in v1.
  (2) diagnostics merge, the server is PULL-only: it never calls
  `sendDiagnostics`; diagnostics arrive only via
  `textDocument/diagnostic` requests, which `codemirror-languageserver`
  never sends (it only handles push `publishDiagnostics`). A preset
  alone would therefore deliver zero diagnostics; Terax must implement
  the pull itself. Merge rule, verified from the lib
  (`LanguageServerPlugin.processDiagnostics` maps server diagnostics
  with no `source` tag and dispatches `setDiagnostics(state, ...)`,
  a full replace): the eslint store's `byPath` (keyed by
  `eslintPathKey`) is the single source of truth for ESLint
  diagnostics, and the pull plugin publishes merged sets, current
  non-ESLint diagnostics plus stored ESLint ones, reusing
  `mergeDiagnostics` / `needsEslintReapply` / `diagnosticsEqual`
  from `lib/eslintMerge.ts`, and watches `setDiagnosticsEffect` to
  re-apply the merged set in a microtask whenever a foreign publish
  (the TypeScript plugin) wipes it. Last publisher wins for its own
  source; the merge layer restores the union within a microtask, so
  the visible end state is always TS ∪ ESLint. Diagnostics from
  different sources at the same range are BOTH kept (different
  messages/sources; CodeMirror shows the most severe in the gutter
  and all of them in the tooltip); no cross-source dedupe, and
  `diagnosticsEqual` prevents redundant dispatches so the reapply
  cannot ping-pong. (3) flat vs legacy, verified live: ESLint
  8.57.0 + `.eslintrc.json` works; the server probes the config type
  (`eslintrc`), loads the project library, and returns the exact
  diagnostic for the user's case (`'cvReport' is assigned a value
  but never used`, line 7, chars 8–16, severity Error,
  `@typescript-eslint/no-unused-vars`), on first pull and on pull
  after didChange. With `useFlatConfig: null` the server follows
  ESLint's own rollout (8.57 defaults to eslintrc); flat config
  (ESLint 9) goes through the same probe path and is untested live
  here, but the user's project is legacy and verified. Architecture:
  preset `eslint` (`vscode-eslint-language-server --stdio`, languages
  ts/tsx/js/jsx → the same languageIds as the TypeScript preset,
  root markers are the ESLint config files + `package.json`, install
  `npm install -g vscode-langservers-extracted`); multi-preset
  acquire, `serversForLanguageEnabled` returns every enabled preset
  for a language, `useLspExtension` acquires all of them (the session
  manager already keys sessions by `(preset.id, root)` with a cap of
  4 per preset, refcounts, idle-kill and crash backoff, so a second
  server cannot clash with the TypeScript session); the statusbar
  hint iterates all candidates and surfaces the first one needing
  attention (install/enable/error), else the first active one.
  The CLI plugin is suppressed while LSP-ESLint is live for a path,
  not unmounted: the pull plugin sets a refcount
  (`lspActivePaths` in the eslint store) on mount and clears it on
  destroy, and `EslintPlugin.run()` returns early while the count is
  non-zero, so the server is the only ESLint source for the file and
  no second, saved-file-only copy of the diagnostics is published.
  Both plugins stay mounted together and both clear the store entries
  on destroy (they are destroyed together when the tab closes). The
  pull plugin also subscribes to the same run-request bus
  (`onEslintRunRequested`), so the manual command
  ("Run ESLint on current file") triggers a pull instead of a CLI run
  while the server is live, and its waiter receives the pull's `ok`
  run status with counts. When the server is absent, disabled, or
  its session failed, the refcount is zero and the CLI plugin stays
  the fallback with Fase 10-11 behaviour unchanged; the project-wide
  Problems panel stays CLI-based. The pull plugin
  (`src/modules/eslint/lib/eslintLspPull.ts`) requests
  `textDocument/diagnostic` via the new
  `TeraxLspClient.textDocumentDiagnostic` (the client also advertises
  the `diagnostic` capability at initialize), 100 ms after mount so
  the language-server plugin's `didOpen` has reached the server,
  with one retry 250 ms later if the first pull races `didOpen`,
  re-pull debounced 400 ms after each buffer edit, 10 s timeout, and
  `previousResultId` so an `unchanged` answer keeps the stored
  diagnostics. The server lints the buffer the editor sent it, so
  unlike the CLI plugin this works on dirty buffers and never waits
  for a save. A successful pull records the `ok` run status (the
  status-bar pill and the manual-run toast read it) and publishes
  the merged set; explorer badges need no new code because
  `diagnosticsReporter` reports the merged lint-state counts.
  Honest limit (verified): the LSP extension hook also gates on
  document `ready`, so Fase 12 does NOT remove the "not ready"
  squiggle for a file whose document is stuck loading. What it
  removes is linting's dependence on the editor plugin lifecycle:
  the server runs on disk, results are ready when the document
  attaches, and the manual command works through the pull instead of
  failing for lack of a CLI listener. The Problems panel still only
  shows CLI project-wide results; LSP results cover open files.
  User setup: once on the laptop, `npm install -g
  vscode-langservers-extracted`, then enable the ESLint server (the
  statusbar pill offers it for a JS/TS file, or Settings, LSP);
  the TypeScript server keeps working alongside it. Verification:
  `pnpm check-types` 0 errors, `pnpm lint` 0 errors (88 warnings,
  1 info, same baseline as Fase 11), full `pnpm test` 2497/2497
  green twice (258 files, +14 tests vs Fase 11). Quick-fix:
  verified server-side feasible, with
  `codeActionLiteralSupport` advertised the server offers
  `codeActionProvider` (`quickfix`, `source.fixAll.eslint`) and
  `textDocument/codeAction` returns real fix commands (verified live
  with a `quotes` violation: "Fix this quotes problem",
  `eslint.applySingleFix`). But Terax's client advertises no
  codeAction capability and the lib has no codeAction /
  executeCommand / applyEdit support, so quick-fix UI is a
  follow-up, NOT this phase.
  Fase 13 (PowerShell-safe shell commands for the ESLint CLI), DONE:
  root cause, every CLI ESLint run died in the PowerShell parser
  before ESLint ran. `buildEslintCommand` builds
  `'...\eslint.cmd' --format json -- <file>`
  (single-quoted binary via `quoteShellArg`), and
  `shell_run_command` runs that string through PowerShell
  (`-NoProfile -Command`, picked by `windows_shell_path`: pwsh,
  then PowerShell 5.1, then cmd). PowerShell reads a leading quoted
  string as an expression, not a program, and rejects `--` with
  "The '--' operator works only on variables or on properties"
  (ParserError, UnexpectedToken), exactly the toast in the user's
  screenshot of the project-wide lint. That is also why no CLI
  diagnostic ever appeared in any phase: the per-file runs use the
  same quoted form, the tests mock the runner, and the Linux VM's
  `sh -c` tolerates it. Fix layer: Rust, in
  `build_oneshot_command` (`src-tauri/src/modules/shell/mod.rs`),
  because only the backend knows which shell will run the command:
  PowerShell needs `& '...'` for a quoted leading path, cmd.exe
  treats a leading `&` as a syntax error, so the frontend cannot
  emit one form correct for both. Pure helper
  `powershell_call_command` prefixes `& ` when the trimmed command
  starts with a single or double quote (and not already with `&`);
  bare-word commands (`npx ...`, `ruff format ...`) pass through
  unchanged. The call site is the Windows non-cmd branch only;
  Unix (`/bin/sh -c`), WSL (`sh -lc`), and cmd (`/C`) paths are
  untouched. One choke point fixes every caller: ESLint per-file
  and project-wide, custom-template formatters, the AI
  `runCommand`, and background processes (all go through
  `build_oneshot_command`). The npx probe was already safe (bare
  `npx` start) and is unchanged. Tests: 7 Rust unit tests for the
  helper (exact per-file and project-wide ESLint shapes with the
  user's CJK path, double-quoted path, bare words,
  already-prefixed, leading whitespace, empty) in a plain
  `#[cfg(test)]` module so they run on every platform.
  Verification: `pnpm check-types` 0 errors, `pnpm lint` 0 errors
  (88 warnings, 1 info, same baseline), full `pnpm test` 2497/2497
  green twice (258 files, unchanged count: no frontend change).
  Rust: helper + tests verified standalone with `rustc --test`
  (7/7) on the verbatim code, and `rustfmt --check` clean for the
  whole file; full-crate `cargo test --lib` cannot run on this
  Linux VM (missing gdk-3.0 dev headers; the runtime lib exists
  but not the -dev package), so the in-crate test run is
  unverified here and the Windows CI build (`pnpm tauri build`)
  is what compiles the changed crate. Honest limit: the `&`
  prefix is only applied in the Windows branch, which no Linux
  run can execute; the rule logic itself is covered by the unit
  tests.
  Fase 14 (drop the `--no-warn-ignored` flag from the ESLint CLI
  command), DONE: Fase 13 got the run past PowerShell, and the next
  error layer surfaced — ESLint itself rejected the flag:
  "Invalid option '--warn-ignored' - perhaps you meant
  '--ignore'?" on the user's project-wide lint. Root cause:
  `--no-warn-ignored` is a Flat Config Mode Only option (ESLint
  docs; also reported for ESLint 8.56.0 in eslint/eslint
  discussion #18019), and the user's project is ESLint 8.57.0
  with a legacy `.eslintrc.json`. `buildEslintCommand` (Fase 10)
  passed the flag unconditionally, so per-file and project-wide
  runs both failed on any legacy-config project. Fix: drop the
  flag from `buildEslintCommand` (one line); in ESLint 9 it is the
  default behaviour anyway, so nothing changes there. The two
  exact command strings in the Fase 13 Rust tests were updated to
  match, and a frontend test now asserts the built command
  contains neither `--no-warn-ignored` nor `--warn-ignored` for
  both the path and npx binaries (per-file and project-wide).
  Honest side effect: in ESLint 9, an ignored file that is
  linted explicitly may now surface as a harmless "file ignored"
  warning diagnostic instead of being silenced — the flag that
  suppressed that warning is gone.
  Bug-fix batch (after Fase 6): three small hardening fixes, no behaviour
  change to the review flow itself. (1) Destructive shell commands:
  `detectDestructiveShellCommand` in `src/modules/ai/lib/security.ts`
  classifies `rm` / `mv` / `del` / `Remove-Item` (and `find -delete` /
  `-exec rm|mv`) in `bash_run` / `bash_background` before they run.
  Catastrophic targets — filesystem root, home, the workspace root
  itself, bare wildcards, system dirs, home secret dirs, `rm -rf` under
  `~` — are refused in `execute` even after the card was approved, with
  a redirect to `delete_file` / `rename_file`; the refusal also closes
  the gap where `rm -r -f ~/x` slipped past `checkShellCommand`'s
  single-bundle flag regex. Scoped deletes/moves inside the workspace
  run as approved, but the approval card (`AiToolApproval.tsx`) shows an
  explicit warning with the kind, the parsed targets, and the fact that
  a shell delete has no checkpoint and cannot be Restored. Detection
  reads the command text (segments split on `;` / `&&` / `||` / `|` /
  `&`, first-word match only, so `echo "rm -rf /"`, `grep -r "rm"`,
  `pnpm remove` and `git rm` / `git mv` are not flagged — git
  operations are versioned and recoverable). Known limits, documented
  honestly: indirection the text cannot see is missed (`xargs rm`,
  `$(rm ...)`, backticks, commands assembled from variables, paths
  piped into `rm`); the approval card showing the command verbatim
  remains the backstop for those. Directory deletes have no reviewed
  tool (`delete_file` refuses directories), so they can only happen
  through the warned shell path. (2) The djb2 hash is a single shared
  copy now (`src/modules/ai/lib/hash.ts`, value-locking test in
  `hash.test.ts`): the old triplicate across `reviewApply.ts`,
  `reviewCheckpoint.ts` and `tools/fs.ts` ("kept in sync by hand") is
  gone — a drift between copies would silently break the conflict and
  checkpoint hash guards. The hash output is part of persisted review
  state and must never change. (3) Two CPU-heavy upstream terminal
  tests are slow, not flaky: the 100,000-update renewal test (~3.4s
  standalone) and the `selectionBoundsContain` test (300 seeded trials
  x 480 cells = 144,000 expects, ~1.5s standalone) both sit too close
  to vitest's default 5s test timeout once workers share CPU under a
  full-suite run — that is the measured cause of the repeated
  `AdaptedGhosttyGpu` timeout flakes since Fase 2 and the single
  `selectionBoundsContain` flake in Fase 6. Both keep their full
  coverage (the 100,000 threshold and the 300 trials ARE the test) and
  carry explicit per-test timeouts (30s / 15s) with comments citing
  the measurements; the default suite still uses the 5s default, only
  the soak/profile configs raise it globally.
- **Tools** (`tools/tools.ts`): `read_file`, `list_directory`, `fs_search`, `fs_grep` auto-execute. `edit`, `multi_edit`, `write_file`, `delete_file`, `rename_file` are write-first since Fase 8 (see AI review above): they write to disk immediately and are reviewed afterwards, and never pause the run; `create_directory` auto-executes. `run_command` (`bash_run` / `bash_background` in `tools/shell.ts`), `spawn_coding_agent`, `send_to_agent` set `needsApproval: true` and the AI SDK pauses for an in-UI confirmation card. `delete_file` and `rename_file` are fork additions (Fase 5, see AI review above): they execute immediately and are reviewed afterwards, and are refused in plan mode. The Rust backend has `fs_rename` / `fs_move` / `fs_delete` / `fs_delete_batch` (`src-tauri/src/modules/fs/mutate.rs`); the agent's reviewed delete/rename revert reuses `fs_delete` / `fs_rename` (via `restoreCheckpoint`), which the file explorer / editor UI also calls. Auto-send after approval uses `lastAssistantMessageIsCompleteWithApprovalResponses`. `lib/security.ts` is a deny-list refusing obvious secret paths (`.env*`, `.ssh/`, credentials, keychain dirs) - apply on **both** read and write paths and don't bypass it.
- **Edit diffs**: AI-proposed edits are reviewed per hunk (see AI review above) before anything is written: inline in the editor when `aiReviewInline` is on (Settings → General), otherwise in a side-by-side diff tab (`ai-diff` tab kind).
- **Prompt snippets** (`#handle`): reusable prompt fragments surfaced in the composer. Do not describe these as skills; a reusable tool-bundled skills system is not implemented yet.

### UI conventions

- **shadcn/ui** is configured (`components.json`, style `radix-luma`, base `mist`, icon lib **hugeicons**). Primitives in `src/components/ui/` - don't hand-edit; re-run `pnpm dlx shadcn add` to upgrade.
- **AI Elements** (Vercel) live in `src/components/ai-elements/` from the `@ai-elements` registry in `components.json`. Same rule: regenerate, don't hand-patch - composition wrappers belong in `modules/ai/components/`.
- **Tailwind v4** - no `tailwind.config.*`, config is in `src/App.css` via `@theme`. Use `cn()` from `@/lib/utils`.
- Animation: `motion` (Framer Motion successor). Resizable layout: `react-resizable-panels`.
- **Animation cost**: nothing animates forever at display rate. Tailwind `animate-spin`/`animate-pulse` are redefined in `globals.css` with `steps()` (12 and ~4 fps), the text shimmer uses 40 steps per sweep, recording indicators use `.terax-blink`, a pending tool approval uses the finite `.terax-attention-pulse`, and persisted history (`bash_background`) never animates. `modules/theme/windowActivity.ts` sets `html[data-window-inactive]` while the window is unfocused, hidden or occluded (DOM focus, document visibility and the terminal's shared native presentation feed, no extra native listener); that attribute pauses every CSS animation and an animated background image freezes on a still frame (`surfaceFrame.ts`). `prefers-reduced-motion` still removes the rest.
- **Compositing budget**: every composited layer costs a backing store, and WebKit allocates a new one per window-resize step for each layer that follows the window. At rest the shell has three layers with contents (page tile, terminal canvas, the terminal's hidden textarea); everything else is clip layers without backing. Do not add `will-change`, 3D transforms (`translateZ`, `transform-gpu`), `backdrop-filter`/`backdrop-blur` or blur filters to anything mounted by default; popovers, HUDs and chips use an opaque `bg-popover`/`bg-card` instead of a translucent blurred one. Only the allowlist in `src/styles/compositingBudget.test.ts` (modal scrims, the background-image overlay, ...) may, each with a reason. A static background image gets no layer (`surfaceOwnsLayer`). While a window drag is live, `html[data-live-resize]` (`modules/theme/livePageResize`, macOS only) gives the document an invisible size rounded up to 512 px so WebKit keeps one page tile size across the drag instead of one per step (`docs/architecture/app-lab.md`, "Compositing layers").
- **Startup graph**: neither window may preload the AI SDK, zod, Streamdown, CodeMirror or the icon set. `vite.config.ts` splits chunks with two prioritised `codeSplitting` groups (eager `react`/`radix`/`ghostty-vt` outrank lazy features, because a lazy chunk's recursive dependency capture once swallowed React's CJS entry and made the eager `react` chunk import every AI provider). `src/app/dist-budget.test.ts` builds into a temp dir with sourcemaps and fails if any forbidden package or chunk is reachable from `index.html`/`settings.html`; `pnpm check:dist` runs the same check on `dist/`. `eager-budget.test.ts` keeps the source-graph check.
- **Long AI chats**: messages older than the newest two get `content-visibility: auto` with an estimated `contain-intrinsic-size` (`messageHeightEstimate.ts`), so layout and paint cost tracks what is near the viewport.
- **Window vibrancy**: the `windowVibrancy` pref drives `WindowVibrancyBridge` (main window only - `window_set_backdrop` targets its caller). `html[data-vibrancy="on"]` (off by default; an explicitly stored choice always wins) makes `<html>`/`<body>` transparent and redefines `--frame` with alpha, so only the chrome frosts; panes keep `--background` so terminal text stays on a solid surface and the terminal canvas still matches its container. The opaque colour the pre-paint script parks on `<html>` would cover the backdrop, so `applyVibrancy` clears it while the effect is on; there is deliberately no localStorage fast path, since pre-declaring the effect would show a see-through window on any launch where the native call has not landed yet. Repeat applications are deduped, and only Mica is rebuilt on a light/dark flip (NSVisualEffectView adapts on its own).
- **Floating panes**: header and status bar are window chrome painted on `--frame` (derived from `--card`, so no theme declares it); the sidebar and the tab surface are `.terax-pane` cards on `--background` - same tone as the terminal canvas. Panes meet the chrome flush and are inset only horizontally, because the header centers its content and any vertical gutter would stack onto that padding and read as asymmetric. `.terax-pane` carries no drop shadow: `react-resizable-panels` clips panel content at the panel box, so a shadow would only render on the gutter sides.
- Path imports: always `@/…`, never relative across modules.
- Cross-platform paths: anywhere a path may originate from OSC 7, the explorer, or the OS, normalize separators with `.split(/[\\/]/)` rather than `.split("/")`.
- Canonical path form on the frontend is **forward-slash**. `homeDir()` returns backslashes on Windows; convert at the boundary (App.tsx setHome). OSC 7 already arrives as forward-slash. Equal canonical strings keep `useFileTree` from wiping its tree and flashing the explorer when `tab.cwd` first arrives.

### Window styling

- macOS: `titleBarStyle: Overlay` + `hiddenTitle: true` in `tauri.conf.json` (native traffic lights via overlay). The main window is created opaque, because a non-opaque `NSWindow` makes WindowServer blend every terminal frame. `window_set_backdrop` makes the window and its `WKWebView` (`drawsBackground`) see-through only while vibrancy is on, and paints the opaque window with the theme's frame colour otherwise. `macOSPrivateApi: true` stays for that `WKWebView` key and the private `NSVisualEffectView` hosting, so the macOS build uses a private API and is not App Store eligible.
- Linux: `decorations: false` + `transparent: true` from `tauri.linux.conf.json`; re-asserted post-realize for GNOME/Mutter CSD. Windows and Linux stay transparent from creation because the borderless chrome paints its own rounded corners.
- Windows: same as Linux via `tauri.windows.conf.json`. React renders custom `WindowControls`.

### Tauri capabilities

`src-tauri/capabilities/default.json` is the allowlist for plugin APIs available to the webview. New plugins (dialog, autostart, updater, window-state, store, opener, os, log are wired in `lib.rs`) typically need:
1. `Cargo.toml` dependency
2. `.plugin(...)` call in `lib.rs` `run()`
3. capability entry in `default.json`

### Cross-platform conventions

- HOME / cache dirs: use the `dirs` crate (`dirs::home_dir()`, `dirs::cache_dir()`), never raw `$HOME` / `%USERPROFILE%`.
- Shell init scripts: gate Unix-only logic behind `#[cfg(unix)]`; Windows arm in `pty::shell_init::windows`.
- Terminal input: send `\r` (CR) for Enter, not `\n` (LF) - PowerShell on Windows requires CR.

### Bundle config

- `bundle.targets: "all"` plus per-platform sections in `tauri.conf.json`:
  - **macOS**: `minimumSystemVersion: 13.0`.
  - **Linux**: deb depends `libwebkit2gtk-4.1-0`, `libgtk-3-0`; rpm `webkit2gtk4.1`, `gtk3`; AppImage bundles its media framework.
  - **Windows**: NSIS installer in `currentUser` mode (no admin required), WebView2 via `downloadBootstrapper`. Installing a missing WebView2 runtime requires internet access; there is no bundled offline runtime. Packaged and offline-install validation remains in the release-readiness gates.
- Auto-updater configured with a public minisign key; release artifacts at `https://github.com/crynta/terax-ai/releases/latest/download/latest.json`.
- `bundle.resources` includes the upstream Ghostty, Restty, ghostty-web, and xterm.js license notices under `licenses/terminal/`. Repository documentation and test-only reference WASM cores are not packaged; the frontend includes only the adapted SIMD and scalar cores.

### Known gotchas

- **React 19 strict mode** double-mounts `useEffect` in dev → terminals spawn twice on first render. The first PTY is cleaned up almost immediately. The `CONPTY_LIFECYCLE_LOCK` mutex serializes this; don't be alarmed by `pty opened id=1` followed by `pty closed id=1` in dev logs.
- **Windows PowerShell process lifecycle**: `killer.kill()` from `portable-pty` only kills the immediate child. Descendants (e.g. `npm run dev` started inside pwsh) survive unless something else takes them down. The Job Object in `pty/job.rs` handles this for the Terax-process-death case; an explicit `pty_close` from JS also kills only the immediate child + relies on the Job to take the rest. Don't disable the Job without a replacement.
- **Tab `cwd` storage**: comes from OSC 7 with forward slashes (after `parseOsc7` strips `/C:` → `C:`). Anything that consumes `tab.cwd` and passes it to a Rust fs command on Windows must normalize separators or accept both forms - `apply_common` in `pty::shell_init` handles this for PTY spawn; other call sites must do their own.

## Further reading

Long-form contributor guides live under `docs/`. These guides elaborate on `TERAX.md`; if anything conflicts, `TERAX.md` wins.

- `docs/README.md` - index of contributor guides
- `docs/architecture/two-process-model.md` - IPC boundary and command reference
- `docs/architecture/pty-shell-integration.md` - PTY, shell init scripts, OSC, ConPTY, Job Object
- `docs/architecture/pty-transport-v2.md` - multiplexed PTY output stream: hub, wire format, presentation classes, credit; `scripts/pty-smoke/` drives it in a real debug app (`python3 scripts/pty-smoke/run.py`)
- `docs/architecture/security-model.md` - consolidated security model and boundaries
- `docs/architecture/ai-subsystem.md` - AI stack, sessions, tools, adding a provider
- `docs/architecture/terminal-renderer-pool.md` - model ownership and presentation pool invariants
- `docs/contributing/testing.md` - testing contract and core-subsystem invariants
