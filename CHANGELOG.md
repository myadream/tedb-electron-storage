# Changelog

All notable changes to this package are documented here. This fork keeps its
own history on top of upstream `@qiyangxy/tedb-electron-storage`.

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
