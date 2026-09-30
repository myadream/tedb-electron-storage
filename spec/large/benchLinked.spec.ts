import {ElectronStorage, mapPool} from '../../src';
import {mkdtempSync, rmSync, readdirSync} from 'fs';
import * as os from 'os';
import * as path from 'path';
import {BENCH_N, keyOf, docOf, range, log, wallLine, newClassStats, bump, classLine} from './benchShared';

/**
 * Linked-operation benchmark: after a bulk insert builds the dataset,
 * ROUNDS of a mixed workload keep adds, updates, removes and point reads
 * in flight together against the same live collection (one interleaved
 * bounded-concurrency dispatch per round), instead of measuring each
 * operation class in an isolated phase.
 *
 * Linkage is verified, not just performed:
 * - round r's query targets are round r-1's updated keys, so every read
 *   must observe the previous round's write (read-your-write across the
 *   mixed stream);
 * - a version ledger tracks the expected document per key, and live-key
 *   accounting is asserted against keys() after every round.
 *
 * Per-class numbers are average per-op latency under concurrency; the
 * wall time of the whole mixed phase is reported separately. The
 * isolated-per-method counterpart is benchSingleMethod.spec.ts.
 *
 * Default N=3000 keeps `pnpm test:large` fast; the ~100k run:
 *
 *   TEDB_LARGE_N=100000 pnpm exec jest spec/large/benchLinked.spec.ts
 */
const ROUNDS = 10;
const PER_ROUND = Math.max(Math.ceil(BENCH_N / 100), 10);

// Disjoint index windows need (4*ROUNDS - 2)*PER_ROUND distinct initial
// keys; keep a little headroom so the guard stays obvious.
if (BENCH_N < 4 * ROUNDS * PER_ROUND) {
    throw new Error(
        `benchLinked: dataset N=${BENCH_N} too small for ROUNDS=${ROUNDS} x PER_ROUND=${PER_ROUND} ` +
        'disjoint windows; raise TEDB_LARGE_N or lower ROUNDS',
    );
}

describe(`bench linked operations (N=${BENCH_N})`, () => {
    let storage: ElectronStorage;
    let rootDir: string;

    beforeAll(() => {
        rootDir = mkdtempSync(path.join(os.tmpdir(), 'tedb-bench-linked-'));
        storage = new ElectronStorage('benchdb', 'benchcol', rootDir);
    });

    afterAll(async () => {
        const t0 = Date.now();
        try {
            await storage.clear();
        } catch (e) {
            // best effort
        }
        rmSync(rootDir, {recursive: true, force: true});
        log(`[bench-linked] cleanup: ${Date.now() - t0}ms`);
    }, 600000);

    test('bulk insert, then interleaved add/update/remove/query rounds', async () => {
        const stats = newClassStats(['add', 'update', 'remove', 'query']);
        const versions = new Map<string, number>();
        const isDeleted = new Set<string>();
        let addCounter = 0;

        // ---- bulk insert: build the dataset ----
        const t0 = Date.now();
        await mapPool(range(0, BENCH_N), 64, (i) => {
            versions.set(keyOf(i), 0);
            return storage.setItem(keyOf(i), docOf(keyOf(i)));
        });
        const insertMs = Date.now() - t0;
        expect((await storage.keys()).length).toBe(BENCH_N);

        // ---- linked mixed rounds ----
        const mixedT0 = Date.now();
        let prevUpdStart = -1;
        for (let r = 1; r <= ROUNDS; r++) {
            const base = (r - 1) * 4 * PER_ROUND;
            const delIdx = range(base, PER_ROUND);
            const updIdx = range(base + PER_ROUND, PER_ROUND);
            // round 1 reads untouched keys; later rounds read exactly the
            // keys the previous round updated -> read-your-write linkage
            const queryStart = r === 1 ? base + 2 * PER_ROUND : prevUpdStart;
            const queryIdx = range(queryStart, PER_ROUND);
            const addKeys = Array.from({length: PER_ROUND}, (_, j) => `ida${addCounter + j}`);
            addCounter += PER_ROUND;

            // interleave one op of each class, then run all 4*PER_ROUND
            // concurrently: the four classes are always in flight together
            const ops: Array<() => Promise<void>> = [];
            for (let j = 0; j < PER_ROUND; j++) {
                const dk = keyOf(delIdx[j]);
                const uk = keyOf(updIdx[j]);
                const qk = keyOf(queryIdx[j]);
                const ak = addKeys[j];
                const expectedQuery = docOf(qk, versions.get(qk)!);
                ops.push(() => bump(stats, 'add', () => storage.setItem(ak, docOf(ak, r))));
                ops.push(() => bump(stats, 'update', () => storage.setItem(uk, docOf(uk, r))));
                ops.push(() => bump(stats, 'remove', () => storage.removeItem(dk)));
                ops.push(() => bump(stats, 'query', async () => {
                    const got = await storage.getItem(qk);
                    expect(got).toEqual(expectedQuery);
                }));
            }
            await mapPool(ops, 64, (op) => op());

            // bookkeeping after the round barrier
            for (const i of delIdx) {
                isDeleted.add(keyOf(i));
                versions.delete(keyOf(i));
            }
            for (const i of updIdx) {
                versions.set(keyOf(i), r);
            }
            for (const ak of addKeys) {
                versions.set(ak, r);
            }
            prevUpdStart = base + PER_ROUND;

            // adds == deletes per round, so the live dataset stays at N
            expect(versions.size).toBe(BENCH_N);
            expect((await storage.keys()).length).toBe(BENCH_N);
        }
        const mixedMs = Date.now() - mixedT0;

        // ---- final full scan + linkage tail checks ----
        let seen = 0;
        const tIter = Date.now();
        await storage.iterate(() => {
            seen++;
        });
        const iterateMs = Date.now() - tIter;
        expect(seen).toBe(BENCH_N);

        const lastUpdIdx = range((ROUNDS - 1) * 4 * PER_ROUND + PER_ROUND, 5);
        for (const i of lastUpdIdx) {
            const k = keyOf(i);
            await expect(storage.getItem(k)).resolves.toEqual(docOf(k, versions.get(k)!));
        }
        for (const k of ['ida0', `ida${addCounter - 1}`]) {
            await expect(storage.getItem(k)).resolves.toEqual(docOf(k, versions.get(k)!));
        }

        const collectionPath = path.join(rootDir, 'benchdb', 'db', 'benchcol');
        const strays = readdirSync(collectionPath).filter((f) => f.includes('.tmp'));
        expect(strays).toEqual([]);

        const tag = `[bench-linked N=${BENCH_N}]`;
        log(`${tag} ${wallLine('insert(bulk)', insertMs, BENCH_N)}`);
        log(`${tag} mixed rounds=${ROUNDS} (add/update/remove/query interleaved, concurrency 64): wall=${mixedMs}ms`);
        for (const cls of ['add', 'update', 'remove', 'query']) {
            log(`${tag} mixed.${classLine(stats, cls)}`);
        }
        log(`${tag} ${wallLine('query.iterate(full scan)', iterateMs, seen)}`);
    }, 3600000);
});
