# Changelog

All notable changes to this package are documented here. This fork keeps its
own history on top of upstream `@qiyangxy/tedb-electron-storage`.

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
