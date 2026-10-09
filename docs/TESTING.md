# Testing

Suites under `spec/`, all runnable via [pnpm](https://pnpm.io):

| Command | What it runs | When to use |
| --- | --- | --- |
| `pnpm test` | everything, including the large suite | pre-release |
| `pnpm test:coverage` | unit + concurrency + large-light with coverage gates | every change |
| `pnpm typecheck` | `tsc --noEmit` | every change |

`pnpm test:coverage` enforces thresholds in `jest.config.js` (statements 95,
branches 88, functions 92, lines 95). They sit just below the measured values
so normal platform variance stays green while a real coverage regression fails
the run.

## Layout

```
spec/
├── helpers.ts              shared fixtures: isolated temp-dir storage, doc
│                           builders, index payload constants, log layout
│                           locators (logManifest / logSegmentsDir)
├── unit/
│   ├── logEngine/          the segment-log engine (ARCHITECTURE §2–§8):
│   │   ├── logRecords.spec     record codec, CRC vectors, damage detection
│   │   ├── logSync.spec        GroupSync coalescing / batch triggers
│   │   ├── logCrud.spec        driver contract: CRUD, indexes, exists,
│   │   │                       iterate, sanitize, clear, reopen, relaxed
│   │   │                       durability, same-key concurrency
│   │   ├── logRecovery.spec    golden truncation matrix, repair/promote/drop,
│   │   │                       garbage tails, manifest rebuild, pid takeover,
│   │   │                       orphan cleanup, repair-during-iterate
│   │   └── logCompact.spec     rolling, history 0/1, promote-on-damage,
│   │                           double-damage drop, forced compaction,
│   │                           clear-during-compaction
│   ├── copyFile.spec.ts        CopyFile util
│   ├── utils.spec.ts           SafeWrite / KeyedQueue / mapPool / RmDir / parse utils
│   ├── publicApiUtils.spec.ts  utils exported from the package root
│   └── appDirectory.spec.ts    per-platform data-dir resolution (os.platform
│                               mocked: darwin/win32/linux/fallback)
├── integration/tedbSmoke   the driver wired into the real `tedb` Database
├── concurrency/            mixed concurrent reads/writes at the driver level
└── large/                  1k–1000+-key scale: correctness smoke, fsync cost,
                            benchmarks (TEDB_LARGE_N sets the dataset size):
                            benchSingleMethod times each operation class in
                            isolation, benchLinked keeps add/update/remove/
                            query in flight together with cross-round
                            read-your-write verification (benchShared.ts)
```

## On-disk layout the tests rely on

```
<collectionPath>/manifest.json            segment list + pid + nextGen
<collectionPath>/segments/seg-000001.log  append-only record stream
```

See [ARCHITECTURE.md §2–§8](ARCHITECTURE.md) for the record format and the
recovery contract the log specs pin.

## Adding tests

- Always build fixtures with `setupStorage()` from `spec/helpers.ts` — it keeps
  every test in its own temp directory. Never construct `ElectronStorage`
  without the `dir` argument in tests: that would write into the real OS
  user-data directory.
- Log-engine knobs make behavior deterministic: small `logSegMaxBytes` forces
  rolling, `logCompactDeadRatio: 0` + `logCompactMinDeadBytes: 1` compacts on
  every displaced generation. After a write that schedules a compaction, one
  read (e.g. `getItem`) gates on it before you assert on-disk state.
- Corruption is injected at record boundaries: read the segment file, decode
  boundaries with `decodeRecordAt`, then flip the last byte of the target
  record. Remember CRC damage does not change record lengths — the dead-byte
  accounting cannot see it, so compaction tests need real displaced
  generations to trigger.
- Crash semantics belong in `logRecovery.spec.ts` (the golden truncation
  matrix lives there); compaction semantics in `logCompact.spec.ts`.
- For corruption scenarios use `writeRaw`/`removePath`; for index payloads use
  the `EMPTY_INDEX` / `nonEmptyIndex()` constants — the empty-index
  placeholder shape (`[{"key":null,"value":[]}]`) is load-bearing for
  `indexCheck`.

## Known uncovered branches (accepted)

Remaining red zones are race windows or unreachable combinations rather than
untested features: `scanSegment`'s non-`LogRecordError` rethrow (the decoder
only throws that class), the write-chain failure swallow (append IO failures
need fs fault injection), stale-entry read arms (a segment disappearing
between keydir lookup and pread — impossible while compaction gates readers),
`compact`'s abort-cleanup catch (needs an IO failure mid-copy), and
`pidAlive`'s EPERM arm (another user's process).
