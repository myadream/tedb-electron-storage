import {ElectronStorage, mapPool} from '../../src';
import {mkdtempSync, rmSync, readdirSync} from 'fs';
import * as os from 'os';
import * as path from 'path';
import {BENCH_N, keyOf, docOf, range, log, wallLine} from './benchShared';

/**
 * Single-method benchmark: every operation class is measured in
 * isolation — bulk insert, point reads, keys, full iterate, bulk update,
 * bulk remove — so each method's ceiling is visible on its own.
 *
 * The linked counterpart is benchLinked.spec.ts, where the same operation
 * classes are kept in flight together against one live dataset.
 *
 * Default N=3000 keeps `pnpm test:large` fast; the ~100k run:
 *
 *   TEDB_LARGE_N=100000 pnpm exec jest spec/large/benchSingleMethod.spec.ts
 */
const READ_STRIDE = 100;
const UPDATE_STRIDE = 10;
const REMOVE_STRIDE = 25;

describe(`bench single-method (N=${BENCH_N})`, () => {
    let storage: ElectronStorage;
    let rootDir: string;

    beforeAll(() => {
        rootDir = mkdtempSync(path.join(os.tmpdir(), 'tedb-bench-single-'));
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
        log(`[bench-single] cleanup: ${Date.now() - t0}ms`);
    }, 600000);

    test('each operation class measured in isolation', async () => {
        // ---- insert: build the dataset ----
        let t0 = Date.now();
        await mapPool(range(0, BENCH_N), 64, (i) => storage.setItem(keyOf(i), docOf(keyOf(i))));
        const insertMs = Date.now() - t0;
        expect((await storage.keys()).length).toBe(BENCH_N);

        // ---- point reads (getItem) ----
        const readIdx = range(0, BENCH_N).filter((i) => i % READ_STRIDE === 0);
        t0 = Date.now();
        const readDocs = await mapPool(readIdx, 32, (i) => storage.getItem(keyOf(i)));
        const readsMs = Date.now() - t0;
        for (let j = 0; j < readDocs.length; j++) {
            expect(readDocs[j]).toEqual(docOf(keyOf(readIdx[j])));
        }

        // ---- keys() (cache hot path) ----
        t0 = Date.now();
        const keys = await storage.keys();
        const keysMs = Date.now() - t0;
        expect(keys.length).toBe(BENCH_N);

        // ---- iterate() (full scan) ----
        let seen = 0;
        t0 = Date.now();
        await storage.iterate(() => {
            seen++;
        });
        const iterateMs = Date.now() - t0;
        expect(seen).toBe(BENCH_N);

        // ---- update every UPDATE_STRIDE-th document ----
        const updateIdx = range(0, BENCH_N).filter((i) => i % UPDATE_STRIDE === 0);
        t0 = Date.now();
        await mapPool(updateIdx, 64, (i) => storage.setItem(keyOf(i), docOf(keyOf(i), 1)));
        const updateMs = Date.now() - t0;
        await expect(storage.getItem(keyOf(0))).resolves.toEqual(docOf(keyOf(0), 1));

        // ---- remove every REMOVE_STRIDE-th document ----
        const removeIdx = range(0, BENCH_N).filter((i) => i % REMOVE_STRIDE === 0);
        t0 = Date.now();
        await mapPool(removeIdx, 64, (i) => storage.removeItem(keyOf(i)));
        const removeMs = Date.now() - t0;

        const afterRemove = await storage.keys();
        expect(afterRemove.length).toBe(BENCH_N - Math.ceil(BENCH_N / REMOVE_STRIDE));

        // no leftover temp files from the whole run
        const collectionPath = path.join(rootDir, 'benchdb', 'db', 'benchcol');
        const strays = readdirSync(collectionPath).filter((f) => f.includes('.tmp'));
        expect(strays).toEqual([]);

        const tag = `[bench-single N=${BENCH_N}]`;
        log(`${tag} ${wallLine('insert', insertMs, BENCH_N)}`);
        log(`${tag} ${wallLine('query.pointReads', readsMs, readIdx.length)}`);
        log(`${tag} ${wallLine('query.keys', keysMs, keys.length)}`);
        log(`${tag} ${wallLine('query.iterate', iterateMs, seen)}`);
        log(`${tag} ${wallLine('update', updateMs, updateIdx.length)}`);
        log(`${tag} ${wallLine('remove', removeMs, removeIdx.length)}`);
    }, 3600000);
});
