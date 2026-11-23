# EXPERIMENTS — csv-reader-speed-01-run-20261121 (Builder log)

Build: `~/workspace/makefun-connect/csv-reader-speed-01-entry/` (main.ts, solve.js,
package.json, LICENSE, README.md, EXPERIMENTS.md — total ~21,8 KB, batas repo 1 MiB).
Semua angka diukur lokal di VM ini (Node v24.22.1, CPU shared 1,5 core, VM padat —
angka absolut bergoyang; yang bisa dipercaya adalah rasio dalam satu run yang sama,
terutama A/B interleaved dalam satu proses). Grader memakai Node 22.23.4, 1 CPU,
gVisor — angka absolut akan beda. TIDAK ada submit dalam pekerjaan ini.

## Baseline (E0) — house csv-reader 1.0.0

- Warm `run()` saja (bench.mjs, median 3 run): **1.433 ms CPU**.
- A/B satu proses, 5 ulangan, GC antar run: baseline **1.407 ms CPU** median.
- Cold first-call (proses fresh, cold.mjs): **~2.000–2.370 ms CPU**.
- End-to-end proses fresh (main.ts baseline: baca cases.json 11 MB, parse, run,
  stringify 11,6 MB): CPU ~3,2–3,6 ms (pengukuran awal, VM sangat padat) /
  ~2,0–2,2 s pada pengukuran ulang yang lebih tenang.

## v1 — indexOf field-jumping + record fast path (ADOPTED, lalu E2)

Hipotesis: referensi lambat karena loop per karakter + `value += c`; lompatan
native `indexOf` + `slice` (SlicedString tanpa salin) jauh lebih murah.
- Record yang linenya tanpa `"` dan tanpa stray CR: `split(',')` native.
- Field unquoted: `indexOf(',')` + `indexOf('\n')`, slice; `\r` dicari via posisi
  next-CR yang di-cache (sekali scan per `\r`, tidak pernah scan ulang).
- Field quoted: lompat antar `"` via `indexOf`; interior di-slice langsung bila
  tanpa `\n`/`\r`, kalau tidak regex replace `\r\n|\r|\n` → `\n` + hitung line.
- Stray CR / quote junk / unterminated: slow path per-field (jarang: 546 call/set).
- Hasil: **6/6 practice, deterministik, warm median 394 ms CPU** (baseline 1.433 ms
  → 3,6×). Backup: `../csv-reader-speed-01-work/solve-v1.js`.

## E2 — cache ujung baris `lineEnd` per record (KEEP, gain ≈ 0)

Hipotesis: `indexOf('\n')` per field (~830 ribu field/set) adalah biaya utama.
Perubahan: hitung ujung baris sekali per baris, pakai ulang untuk semua field
di baris itu (recompute hanya saat `pos` melewatinya, mis. setelah quoted
multi-baris). Hasil: **406 ms vs 394 ms** — tidak ada perbaikan (dalam noise).
Keputusan: KEEP — kodenya tidak lebih lambat, dan secara teori menghilangkan
~800 ribu scan `\n`; bukan sumber bottleneck. Profil sesudahnya: yang dominan
adalah loop utama + GC, bukan pencarian `\n`.

## Statistik jalur (counter, 1 set practice)

- Record fast path: 12.167 (19%); slow path: 51.529 (81%) — 76% baris mengandung `"`.
- Field berkutip: 95.116 (~11,5% dari ~830 ribu field); chunk quoted: 122.709,
  7.686 di antaranya mengandung line break; `unquotedSlow`: 546 call.
- Kesimpulan: mesin utama harus membuat field unquoted semurah mungkin; quoted
  field adalah minoritas tapi 81% record mengandung minimal satu.

## Validasi correctness (v2 = kode final)

- Practice 6/6 identik vs `practice/reference/expected.json` (canonical compare
  ala scorer) — diulang di setiap perubahan.
- Edge Critic (50 case, `edge-compare.mjs` vs oracle vendor): **50/50 pass**,
  pertama kali jalan — v2 sudah benar menangani C1–C10 by construction:
  unterminated = reset pos/line + re-read unquoted prefix `"`; semua error pakai
  `recordLine`; stray CR tidak mengakhiri record / tidak menaikkan line;
  CRLF=1, CR-dalam-kutip=1, stray=0; quote_junk setelah junk selesai dibaca
  (stray di junk mendahului junk); skip hanya 1 field kosong UNQUOTED;
  width dari record pertama, header kosong → `columns: []`;
  `short_row.fields` pra-padding, `long_row.extra` terpotong; UTF-16 code unit;
  BOM hanya pos 0. Tidak ada perbaikan kode yang dibutuhkan dari temuan Critic.
- Sintetis diferensial (generator kit, 12 seed baru, `synth.mjs`): **12/12 pass**,
  total 3.773 error oracle tercakup (vs 1.770 di practice).
- Scorer asli kit (`program/scorer/main.ts`) atas `answers.json` end-to-end:
  `{"passed":1,"cases_passed":6,"cases_total":6}`.
- Determinisme: 2 run `JSON.stringify` identik (bench) — key objek dibangun
  dengan urutan tetap (`columns, rows, errors`; error `{code, line, row}` +
  `fields`/`extra`); tanpa Date/random.

## Perbandingan Explorer P-B2 / P-B3 (head-to-head, harness sama)

Explorer (independen): P-B2 slice-charCodeAt single pass, P-B3 = P-B2 + unquoted
inline. Keduanya 50/50 edge + 12/12 sintetis (cross-check independen yang bagus).
- Warm A/B satu proses: **mine 214 ms vs P-B2 442 ms**; **mine 205 ms vs P-B3 505 ms**.
  Angka tenang Explorer (P-B2 226 ms) tidak terreproduksi di VM padat ini; dalam
  harness yang sama, indexOf-jumping menang karena scan dilakukan di C++ dan
  charCodeAt menyentuh ~10 juta karakter di JS.
- Cold first-call (default flags): mine 1.071–1.129 ms, P-B2 1.124–1.200 ms,
  P-B3 1.215–1.225 ms — praktis seri, mine sedikit tercepat.
- Cold first-call (`--no-opt`): **mine 454–567 ms**, P-B2 928–941 ms,
  P-B3 808–1.089 ms.
- Keputusan: **TETAP pakai v2 sendiri**; P-B2/P-B3 tidak diadopsi (lebih lambat
  warm maupun cold di pengukuran head-to-head ini).

## E3 — `--no-opt` via setFlagsFromString di main.ts (ADOPTED)

Hipotesis (Critic M5): tiap heat round = proses fresh, jadi `run()` selalu dingin;
biaya optimasi TurboFan atas hot loop lebih besar daripada yang dihematnya pada
parse ~0,2 s (warm).
- Cold first-call CLI flag: default 998–1.128 ms → `--no-opt` **526–588 ms**.
- `--no-opt --no-lazy`: 653–720 ms (lebih lambat dari `--no-opt` saja).
  `--no-lazy` saja: 1.078–1.190 ms (tidak membantu).
- Via `setFlagsFromString('--no-incremental-marking --no-opt')` di main.ts
  (mekanisme yang sama dengan baseline; rules eksplisit membolehkan tuning flag
  V8 dengan cara ini): e2e CPU **1,52–1,71 s vs 1,97–2,21 s** default flags;
  wall 1,24–1,40 s vs 1,59–1,84 s. Tetap 6/6 + edge 50/50 + sintetis 12/12
  di bawah `--no-opt` (semantik tidak berubah, hanya optimasi yang mati).
- Catatan: `--no-opt` tidak boleh di NODE_OPTIONS (Node menolaknya); harus lewat
  `setFlagsFromString` — seperti yang dipakai entry ini.

## Ditolak dengan bukti (Explorer, tidak diulang Builder)

- Buffer/Uint8Array + tabel 256-entry: roundtrip 663 ms; `Buffer.from` saja 91 ms;
  decode per-field jauh lebih mahal daripada slice.
- Serializer JSON kustom di main.ts: 5.960 ms vs `JSON.stringify` 1.163 ms (5×
  lebih lambat). Tetap pakai `JSON.stringify` native.
- Regex tokenizer: scan 127 ms vs charCodeAt 78 ms + 1 objek match per delimiter.
- Memo/precompute: slice sudah murah; lookup Map lebih mahal; caching antar
  case dilarang rules.
- Split per baris + gabung paritas: hipotesis saja; lower bound menipu (~80%
  baris tetap butuh slow path); risiko correctness tinggi di unterminated.

## Hasil akhir (entry final)

- Warm `run()` A/B satu proses: **mine 186 ms vs baseline 1.407 ms (7,6×)**.
- Cold `run()` first-call: **mine ~0,5 s (`--no-opt`) vs baseline ~2,2 s**.
- End-to-end proses fresh (main.ts final): **CPU 1,52–1,71 s, wall 1,24–2,82 s**
  (wall bergoyang karena throttling VM shared; CPU stabil), maxrss ~242 MB
  (baseline ~415 MB), jauh di bawah wall budget 10 detik.
- Breakdown biaya tetap (tidak bisa dipangkas dari JS): `JSON.parse` cases
  ~78 ms + `JSON.stringify` answers ~367 ms + baca file + startup Node ~190 ms.
- Repo: ~21,8 KB total (solve.js 8.676, main.ts 1.840, README 1.660,
  LICENSE 1.066, package.json 23, EXPERIMENTS.md 8.565) — jauh di bawah batas 1 MiB.
- Kepatuhan: JS/TS saja, TANPA WASM / native addon / prebuilt binary / network /
  install; tanpa caching antar case (semua state di dalam satu `run()`);
  deterministik byte-identik 2 run; objek jawaban urutan key tetap.

## Yang BELUM terverifikasi

- `grade-local` (driver docker): **docker tidak ada di VM ini** — tidak bisa jalan.
- Node 22.23.4 (grader) vs Node 24.22.1 (lokal): rasio diharapkan bertahan,
  absolut tidak.
- Skor server / wall & CPU di gVisor 1 CPU: tidak ada skor resmi (dilarang submit
  otomatis). Jangan klaim Top 1.
- Kit lokal level 36, situs di level 37 saat `referrals` dijalankan — parent
  sebaiknya re-download kit sebelum submit (bundle kompetisi tidak berubah,
  CLI-nya yang lebih baru).
- README memakai owner/repo `nirvana-dev-0/csv-reader-speed-01` (dari repo
  Sokoban user) + referral code `38ndzzww` — **verifikasi owner/repo sebelum
  submit**; badge harus tanpa placeholder `{owner}`/`{repo}`.
- Repo GitHub harus dibuat SETELAH 21 Nov 2026 02:42 UTC (check
  `repo_created_after_open`) + About GitHub (homepage bounty + topik makefun)
  — urusan submit, bukan build.
