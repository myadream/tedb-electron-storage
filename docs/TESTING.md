# Testing

Four tiers under `spec/`, all runnable via [pnpm](https://pnpm.io):

| Command | What it runs | When to use |
| --- | --- | --- |
| `pnpm test` | everything, including the ~60 s large suite | pre-release |
| `pnpm test:coverage` | unit + integration + concurrency with coverage gates | every change |
| `pnpm test:large` | `spec/large` only | durability/perf work |
| `pnpm typecheck` | `tsc --noEmit` | every change |

`pnpm test:coverage` enforces thresholds in `jest.config.js` (statements 95,
branches 88, functions 92, lines 95). They sit just below the measured values
so normal platform variance stays green while a real coverage regression fails
the run.

## Layout

```
spec/
├── helpers.ts              shared fixtures: isolated temp-dir storage, path
│                           builders (baseFile/pastFile/index*File), corruption
│                           and raw-write helpers, EMPTY_INDEX constant
├── unit/                   driver methods against a real filesystem
│   ├── setItem / getItem / removeItem / keys / iterate / allKeys
│   ├── index.spec.ts           storeIndex/fetchIndex/removeIndex + indexCheck
│   ├── existsSanitizeClear     exists, collectionSanitize, clear
│   ├── durability.spec.ts      strict (fsync) vs relaxed durability modes
│   ├── copyFile / utils        file utils, KeyedQueue, mapPool
│   ├── existsRecovery.spec.ts  Exists() backup matrix (non-destructive probe)
│   ├── recoveryMatrix.spec.ts  full (base × backup-dir × backup-file) matrix
│   │                           across getItem/setItem/keys/iterate/
│   │                           fetchIndex/storeIndex
│   ├── publicApiUtils.spec.ts  utils exported from the package root that the
│   │                           driver itself never calls
│   └── appDirectory.spec.ts    per-platform data-dir resolution (os.platform
│                               mocked: darwin/win32/linux/fallback)
├── integration/tedbSmoke   the driver wired into the real `tedb` Database
├── concurrency/            concurrent writes, mixed read/write, parallel scans
│                           and index operations (KeyedQueue + SafeWrite races)
└── large/                  1k–100k-key scale: correctness smoke, fsync cost,
                            dedup; benchmarks (TEDB_LARGE_N sets the dataset
                            size, e.g. 100000): benchSingleMethod times each
                            operation class in isolation, benchLinked keeps
                            add/update/remove/query in flight together on one
                            live dataset with cross-round read-your-write
                            verification (shared helpers: benchShared.ts)
```

## On-disk layout the recovery tests rely on

```
<collectionPath>/<key>.db                          current data ("base")
<collectionPath>/`v0.0.1/states/<key>/past         previous data ("backup")
<collectionPath>/index_<key>.db                    index base
<collectionPath>/`v0.0.1/states/index_<key>/past   index backup
```

Recovery semantics every method must preserve:

- **getItem / fetchIndex / keys / iterate** — repair paths: if the base is
  missing or unparsable, recover from the backup (copy it over the base); if
  the backup is also gone or unparsable, delete both and untrack the key.
- **exists** — non-destructive: answers the question and removes only provably
  garbage backups; never resurrects data.
- **setItem / storeIndex** — write-through: base always ends up holding the new
  payload; the backup holds the previous one (or the new one when the base was
  missing). With `lazyBackup` (default on) a key's *first* write persists the
  base file only and the backup appears with its first update — recovery then
  takes the "no backup dir" branch for never-updated keys. Seeding fixtures
  that need an existing backup must write twice (see `seedTwoIndexVersions` in
  `recoveryMatrix.spec.ts`).

## Adding tests

- Always build fixtures with `setupStorage()` from `spec/helpers.ts` — it keeps
  every test in its own temp directory. Never construct `ElectronStorage`
  without the `dir` argument in tests: that would write into the real OS
  user-data directory.
- For corruption scenarios use `corruptFile` / `writeRaw` / `removePath`; for
  index payloads use the `EMPTY_INDEX` / `nonEmptyIndex()` constants — the
  empty-index placeholder shape (`[{"key":null,"value":[]}]`) is load-bearing
  for `indexCheck`.
- New recovery branches belong in `recoveryMatrix.spec.ts`: seed two versions,
  break exactly one thing on disk, then assert both the resolved value and the
  resulting on-disk state.

## Known uncovered branches (accepted)

Remaining red zones are race windows or unreachable combinations rather than
untested features: files vanishing between a directory listing and the read
(`Keys.ts` combo-read `read: false` paths), `RemoveDirectoryAndFile`'s
"backup dir missing" arm (both files corrupted *and* the directory gone at
once), error-wrapper lines that need fault injection, and the `SafeWrite`
error path's best-effort `close(fd)` arm (a write/sync failure *after* the
temp file opened — unreachable without mocking the fs layer).
