# Changelog

All notable changes to this package are documented here. This fork keeps its
own history on top of upstream `@qiyangxy/tedb-electron-storage`.

## 0.8.0

> **Breaking major.** The segment log is now the *only* storage engine. The
> files engine (one file per document, `states/*.past` backups) has been
> removed entirely — 0.8.0 serves new collections only and cannot read data
> written by ≤ 0.7.x (stay on 0.7.x if you have existing collections).

### Features

- **Log-structured storage** — every collection is an append-only segment log
  (bitcask-style): records stream into 8 MiB segments, a memory keydir maps
  each key to its current and previous generation. Writes are a single
  sequential append, "past = previous generation" is a keydir slot instead of
  a file copy (updates no longer copy anything), `keys()` is O(1) and
  `exists()` is a zero-IO in-memory probe. Full behavior contract:
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
  - **Group commit** — strict durability coalesces concurrent writers into one
    fsync (2 ms window / 1 MiB / 256 ops triggers); relaxed gains a 1 s
    fallback fsync that bounds the loss window.
  - **CRC-checked records** — torn tails (crash mid-append) are truncated at
    startup; external corruption is detected per record and repaired from the
    previous generation, mirroring the historical recovery matrix.
  - **Compaction** — dead records are reclaimed into fresh segments
    (dead-ratio rule, or forced past 128 segments); crash-safe by ordering
    (manifest swap last); a damaged current generation is promoted from prev.
  - **Single-instance guard** — the manifest records the owning pid; opening
    a collection whose live manifest names another process is refused, a dead
    pid is taken over.
- Options: `durability` ('strict' default), plus log tunables
  `logSegMaxBytes` (8 MiB), `logHistory` (1 — keeps one previous generation;
  0 = current only), `logCompactDeadRatio` (0.5), `logCompactMinDeadBytes`
  (4 MiB). `IStorageDriver` itself is unchanged.

### Breaking changes

- **Files engine removed** — `src/StorageDriver` keeps only `Driver.ts` and
  `IndexCheck.ts`; the per-document file layout (`<key>.db`,
  `states/<name>.past`) is gone. No migration: rebuild collections or stay on
  0.7.x.
- **Constructor options removed**: `engine` (there is only one engine now) and
  `lazyBackup` (backup semantics come from `logHistory`).
- **Public exports removed**: the files-driver functions (`GetItem`, `SetItem`,
  `Clear`, `FetchIndex`, `Iterate`, `Keys`, `RemoveItem`, `StoreIndex`,
  `RemoveIndex`), the PastLocation backup utils (`pastFilePath`,
  `findPastFile`, `readPastFile`, `writePast`, `copyBaseToPast`,
  `writePastAndBase`, `removeLegacyBackup`, `removeBackup`), and
  `ClearDirectory`. `indexCheck` and all low-level fs utils remain.
- **`IStorageDriverExtended`**: `version`, `lazyBackup` and `engine` fields
  removed; `allKeys`/`allKeysSet` mirrors remain.
- **Dependency removed**: `tedb-utils`.

### Performance

10 万数据集基准（Windows/NTFS，strict，mapPool 64，与 0.7.x files 基线同机同盘同条件，
完整表格见 [docs/OPTIMIZATION.md](docs/OPTIMIZATION.md)）：

| 相 | files (0.7.x) | log (0.8.0) | 变化 |
| --- | --- | --- | --- |
| insert 10 万 | 468 s | **133.7 s** | 3.5× |
| update 1 万 | 63.5 s | 22.7 s | 2.8× |
| iterate 10 万 | 13.4 s | 7.2 s | 1.9× |
| cleanup | 39 s | **0.024 s** | ~1600× |
| 联动套件合计 | 626 s | ≈ 213 s | 2.9× |

唯一回退：remove（unlink → tombstone+fsync 的语义成本，4 千条 5.2 s → 13.4 s）。
顺序单线程 strict 写在修复组提交窗口的 Windows 定时器钳制后为 3.13 ms/op
（files 顺序 strict 为 4.68 ms/op）。

### Tests

- `spec/unit/logEngine/` (5 suites): record format/CRC vectors, group commit
  coalescing, the driver contract, a golden truncation matrix (every torn-tail
  cut keeps exactly the complete records), repair/promote/drop on damaged
  generations, manifest rebuild and pid takeover, orphan cleanup,
  rolling/compaction incl. forced compaction and history 0/1. The large
  benchmarks and the tedb integration smoke run on the log engine.
- Removed the files-engine suites they used to pin (recovery matrix, lazy
  backup, flat-past migration, files concurrency); 15 suites / 128 tests
  green; coverage gates unchanged.

## 0.7.0

### Features

- **Flat backup layout (`states/<name>.past`)** — a key's (or index's) backup
  is now one flat file inside `states/` instead of a per-key directory
  (`states/<key>/past`). `states/` stays a pure file directory, which lifts
  the ext4 ~65k-subdirectory hard limit (large updated collections failed with
  EMLINK on Linux) and halves the per-key inode cost. All backup location,
  read, write and cleanup flows are centralized in the new
  `utils/PastLocation.ts`.
- **Automatic legacy migration** — backups written by ≤ 0.6.0
  (`states/<name>/past`) stay readable; the first successful past write of a
  key migrates it to the flat layout and removes the old directory. No
  conversion step is required. Reads never migrate: a legacy past is only
  consumed (and left in place) until the key is written again.
- New public utilities: `pastFilePath` / `findPastFile` / `readPastFile` /
  `writePast` / `copyBaseToPast` / `writePastAndBase` / `removeLegacyBackup` /
  `removeBackup` (new `(statesDir, name)` signature).

### Breaking changes

- `MakeVersionDirPast` and `WriteNewPastandBase` are removed (superseded by
  `writePast` / `writePastAndBase` / `copyBaseToPast`); `removeBackup` now
  takes `(statesDir, name)`; `safeRmDir` is removed (no internal caller left).
  All were only consumed by the driver itself; on-disk data migrates
  transparently.
- `fetchIndex` on a base-missing, backup-gone index now resolves `undefined`
  (the "no backup at all" value), unifying it with the no-directory case —
  the old `null` was an accident of the removed directory probe.

### Tests

- New `spec/unit/pastMigration.spec.ts` pins the 0.6.0 → 0.7.0 contract:
  write-time migration, legacy read-back for getItem/fetchIndex/keys,
  flat-over-legacy precedence, non-migrating reads. `helpers.ts` exposes
  `pastFile`/`indexPastFile` for the flat layout plus `legacyPastDir`/
  `legacyPastFile` for fixtures.

## 0.6.0

### Features

- **Lazy backup (`lazyBackup`, default on)** — a key's first write persists
  only the base file; the past backup is created by that key's first update.
  Inserts cost one atomic write instead of two, and append-heavy datasets keep
  roughly half the files on disk. `{lazyBackup: false}` restores the legacy
  first-write duplication. Behavior note: a never-updated key has no backup, so
  losing its base file outside the atomic-write window drops the key on the
  next read — the same handling the driver always applied to keys without a
  backup directory. The "base missing but backup directory exists" recovery
  branch still writes both locations.
- **Stat-based existence probes** — `setItem` / `storeIndex` / `removeItem` /
  `removeIndex` no longer read the whole base file just to learn whether it
  exists; they `stat` it, removing one full-file read per write.

### Performance

- **SafeWrite syscalls merged** — one `open` now serves write + fsync + close;
  the old flow reopened the temp file through `FlushStorage` just to fsync it.
- **removeBackup slimmed** — backup-dir cleanup no longer reads the past file
  before unlinking it (`unlink` already tolerates ENOENT).
- **Scan concurrency 32 → 128** (`IO_LIMIT`) — collection-wide scans
  (`keys` / `iterate` / `collectionSanitize` / `clear`) hide more per-open
  latency; a 100k-file full scan drops well under 5s on the reference machine.
- 10 万数据集 before/after 基线（`spec/large/benchSingleMethod` /
  `benchLinked`）见 [docs/OPTIMIZATION.md](docs/OPTIMIZATION.md)。

### Tests

- New `spec/unit/lazyBackup.spec.ts` pins both modes; `recoveryMatrix.spec.ts`
  seeds fixtures that need a backup with two writes; first-write expectations
  in `setItem` / `removeItem` / `index` specs updated to the lazy semantics.

## 0.5.0

First version of this fork actually published to npm (upstream latest is
0.2.2). The intermediate 0.3.0 / 0.4.0 milestones below were never released
separately — 0.5.0 ships their combined contents. See those sections for the
full feature and fix list; everything else in this release:

- Coverage raised to 97% statements / 91% branches (166 tests) with recovery
  matrices for every driver method, and threshold-gated `pnpm test:coverage`.
- Documentation set: `AGENTS.md`, `docs/TESTING.md`, refreshed README.

## 0.4.0

### Features

- **Durability levels** — `new ElectronStorage(db, collection, dir?, {durability})`.
  `'strict'` (default) fsyncs every write; `'relaxed'` skips fsyncs but keeps
  the atomic rename (~3× faster inserts, ~2× updates on Windows). Recovery
  writes always run strict.
- **Byte-exact backups** — `CopyFile` now uses graceful-fs `copyFile` (kernel
  copy) and rejects on IO errors instead of silently skipping; a backup always
  holds the exact previous generation of a file.
- **O(1) key tracking** — `allKeys` gained a `Set` mirror with
  `trackKey`/`untrackKey` on the driver; duplicate checks no longer rescan the
  array.
- **Custom data directory** — third constructor argument pins the storage root
  (`AppDirectory`); omitting it falls back to the OS user-data location.

### Fixed

- **Options were silently dropped by fs wrappers** — `ReadFile`, `WriteFile`,
  `AppendFile` and `safeReadFile` filled in defaults for missing options but
  never copied caller-provided values, so e.g. `ReadFile(f, stats, {encoding:
  'utf8'})` returned a Buffer and `{flag: 'wx'}` was replaced by `'w'`. The
  merge now keeps provided values and defaults only the missing ones.
  (Regression tests in `spec/unit/publicApiUtils.spec.ts`.)
- **`safeStat` mis-detected missing files on Windows** — it matched
  `errno === -2` (the POSIX ENOENT number; Windows reports -4058), so a
  missing path rejected instead of resolving `false`. Now matches on
  `err.code === 'ENOENT'`, consistent with `safeReadFile`.

### Testing

- Coverage raised from 83% / 62% (statements / branches) to **97.6% / 91.1%**
  with four new suites: `publicApiUtils` (root-exported utils), 
  `existsRecovery` (Exists backup matrix), `recoveryMatrix` (full
  base × backup-dir × backup-file matrix across all driver methods) and
  `appDirectory` (per-platform path resolution with mocked `os.platform`).
- `pnpm test:coverage` runs the fast tiers with threshold gates
  (statements 95 / branches 88 / functions 92 / lines 95) configured in
  `jest.config.js` — coverage regressions now fail the run.
- Testing conventions and the recovery-semantics contract are documented in
  [docs/TESTING.md](docs/TESTING.md).

## 0.3.0

- Concurrent-use safety: per-key operation queue (`KeyedQueue`), atomic writes
  (`SafeWrite`: temp file + fsync + rename, with Windows EPERM retry), bounded
  scan fan-out (`mapPool`, `IO_LIMIT` = 32), cache validation by set
  comparison in `keys()`.
- Toolchain moved to pnpm + Vite 8 (lib mode) + Jest; real filesystem errors
  no longer masquerade as "file missing" (`safe*` helpers resolve `false`
  only for ENOENT).
- `iterate` callbacks receive `(value, key)` matching tedb's `Datastore`
  expectations.
