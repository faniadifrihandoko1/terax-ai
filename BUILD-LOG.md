# Build Log — Terax Fork (Antigravity-style per-line review)

- **Tanggal:** 2026-11-07 (UTC 11:37–12:39, WIB 18:37–19:39)
- **Fork:** `~/workspace/terax-fork/`, basis upstream v0.9.0 (`d0b569c0`), HEAD `8ca5641`
  (Fase 1 + Fase 2 selesai, 16 commit, tidak di-push)
- **Target:** binary desktop Linux (Tauri 2 + Rust + React)
- **Mesin:** VM Linux x86_64 headless, tanpa display. RAM total 7,7 GiB,
  available berfluktuasi karena host memory balloon (tercatat 478 MiB – 5,4 GiB
  selama build; saat link `terax_lib`, rustc memakai ~1,6 GiB RSS).
  Disk `/home/hatch` 143 GiB kosong. Swap sistem 1,0 GiB saja.
  Swapfile tambahan TIDAK bisa dibuat: `swapon` ditolak
  (`Operation not permitted`, container), dan `/` (overlay 7,5 GiB) tidak
  muat file 8 GiB.

## Prasyarat yang dipasang selama build ini

- **Rust 1.99.1** (cargo 1.99.1, host `x86_64-unknown-linux-gnu`) via rustup
  — sebelumnya TIDAK ada cargo/rustc/rustup di VM ini.
- **pnpm 11.9.0** via `npm install -g pnpm@11.9.0` (`/usr/bin/pnpm`).
- **Dependensi sistem Tauri (apt, sebagai root):**
  `libwebkit2gtk-4.1-dev` (webkit2gtk 2.52.6), `libgtk-3-dev` (3.24.41),
  `libsoup-3.0-dev` (3.4.4), `libayatana-appindicator3-dev` (0.5.90),
  `librsvg2-dev` (2.58.0), `build-essential`, `libxdo-dev`, `libssl-dev`,
  `curl`, `wget`, `file`.
  - Catatan: `apt-get update` pertama macet ~18 menit di mirror
    `mirror.cogentco.com` (fetch Translation-en). Solusi: bunuh apt,
    update ulang dengan `-o Acquire::Languages=none
    -o Acquire::http::Pipeline-Depth=0`, lalu ganti sumber apt ke
    `azure.archive.ubuntu.com` saja (hapus cogentco dari
    `/etc/apt/sources.list.d/ubuntu.sources`; backup di
    `/tmp/ubuntu.sources.bak` — file /tmp sudah terhapus runtime,
    sumber saat ini hanya azure.archive).
  - `gcc` 13.3.0 dan `pkg-config` 1.8.1 sudah ada sebelumnya.

## Perintah build (sesuai repo)

Perintah resmi dari `tauri.conf.json` (`beforeBuildCommand`):
`pnpm build:cli && pnpm build`, lalu `pnpm tauri build`.
Dijalankan dengan `CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0`
(hemat RAM; paralelisme lebih tinggi tidak dipakai karena available RAM
saat itu hanya ~0,5–1,5 GiB dan swap tambahan tidak bisa dibuat).

1. `pnpm build` (tsc + vite) — **BERHASIL**, exit 0, `dist/` 7,2 MiB,
   built dalam 24 dtk.
2. `pnpm tauri build` (penuh, targets `all`) — kompilasi Rust
   **BERHASIL** (`Finished release profile in 15m 50s`), `.deb` dan `.rpm`
   jadi, lalu **gagal di AppImage** (lihat bawah). Exit 1.
3. `pnpm tauri build --bundles deb,rpm` — `.deb` + `.rpm` jadi
   (`Finished 2 bundles`), lalu **gagal di signing updater**
   (lihat bawah). Exit 1.
4. `pnpm tauri build --bundles deb,rpm --config
   '{"bundle":{"createUpdaterArtifacts":false}}'` — `.deb` baru
   (12:39) dihasilkan; exit code akhir run ini tidak sempat terbaca
   (sesi background hilang saat /tmp dibersihkan runtime), tapi
   timestamp `.deb` yang diperbarui + `dpkg-deb --info` yang valid
   membuktikan langkah bundling selesai.

## Artefak (terverifikasi)

| Artefak | Ukuran | SHA-256 |
|---|---|---|
| `src-tauri/target/release/terax` | 12.564.368 byte | `e4a74c2a43828f36459ba5a886fa5cf0a2dd6ece6d579c897495aee7c1ccc1b7` |
| `src-tauri/target/release/terax-cli` | 407.688 byte | `e5a4fabcdbb4829b5edfe68e6665e5bcb502cf90a1d3fa9690b11bf772733fe0` |
| `src-tauri/target/release/bundle/deb/Terax_0.9.0_amd64.deb` | 6.944.408 byte | `df8cb556f924a2ab615b05c77693ac561caa76927c11abca67d08de61f64fe6f` |
| `src-tauri/target/release/bundle/rpm/Terax-0.9.0-1.x86_64.rpm` | 6.945.780 byte | `8fc085309cf641d2503849a704cbaf07f8dcc4612c0180f224a6f5b62386c806` |

Verifikasi isi fork di artefak:
- `dpkg-deb --contents` pada `.deb`: `usr/bin/terax`,
  `usr/bin/terax-cli`, ikon, `Terax.desktop`. Dependensi:
  `libwebkit2gtk-4.1-0, libgtk-3-0`. `git status` fork bersih.
- String UI Fase 1+2 ada di frontend hasil build (`dist/assets/*.js`):
  `Preview result`, `Reject remaining`, `Perlu review`, `reviewing`,
  `lineDecision` (8×), `setAiDiffLineDecision` (2×). Nama fungsi yang
  di-minify (`apply_reviewed_edit`, `ChangedFilesCard`,
  `computeLineChanges`) tidak muncul sebagai literal — wajar, bundler
  me-rename identifier lokal. Frontend JS juga ter-embed/terkompresi di
  binary Rust sehingga `strings` pada `terax` tidak menemukan literal
  tersebut (sudah diketahui dari laporan REA).
- Binary TIDAK pernah dijalankan (VM headless, tanpa display) dan `.deb`
  TIDAK di-install ke sistem.

## Yang gagal (dan penyebabnya)

1. **AppImage — `failed to run linuxdeploy`.**
   Download AppRun + `linuxdeploy-x86_64.AppImage` + plugin AppImage
   dari GitHub berhasil (cache di `~/.cache/tauri/`), tapi linuxdeploy
   tidak bisa dieksekusi: **`/dev/fuse` tidak ada di container ini**,
   jadi AppImage tidak bisa di-mount. Ini batasan lingkungan, bukan
   bug fork. `Terax.AppDir` sempat terbentuk, file `.AppImage` tidak jadi.
2. **Updater signing — `A public key has been found, but no private key.
   Make sure to set TAURI_SIGNING_PRIVATE_KEY`.**
   `tauri.conf.json:118-119` berisi pubkey updater milik upstream dan
   `createUpdaterArtifacts: true`. Private key upstream tidak ada di
   fork, jadi penandatanganan artefak updater gagal SETELAH `.deb`/`.rpm`
   selesai dibuat. Run ke-4 menonaktifkan updater artifacts via
   `--config` override (tanpa mengubah repo) dan `.deb` baru dihasilkan.
3. **apt mirror lambat** (lihat atas) — teratasi dengan ganti ke
   azure.archive.ubuntu.com + `Acquire::Languages=none`.

## Langkah berikutnya yang disarankan

- Pakai `.deb` di atas untuk install di laptop Linux (Ubuntu 24.04,
  butuh `libwebkit2gtk-4.1-0` + `libgtk-3-0` — sudah jadi dependensi
  paket). Untuk laptop Windows user, build Windows harus jalan di
  Windows / GitHub Actions — VM Linux ini tidak bisa menghasilkan
  `.exe`/`.msi`.
- Bila AppImage dibutuhkan: build di mesin dengan FUSE (`/dev/fuse`),
  atau extract linuxdeploy dan jalankan hasil ekstraknya secara manual.
- Bila updater signing dibutuhkan: generate keypair baru
  (`pnpm tauri signer generate`) dan ganti pubkey di `tauri.conf.json`
  dengan pubkey baru — itu mengubah config fork, jangan dilakukan
  diam-diam.
- Catatan: log mentah build ada di `/tmp/terax-*.log`, tapi `/tmp`
  (tmpfs) dibersihkan runtime saat build selesai — hanya ringkasan ini
  yang tersimpan.
