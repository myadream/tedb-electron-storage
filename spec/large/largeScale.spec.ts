import {ElectronStorage, mapPool} from '../../src';
import {mkdtempSync, rmSync, readdirSync} from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Large-scale smoke: bounded-concurrency bulk insert, scan and update.
 * Scale is controlled with TEDB_LARGE_N (default 3000 to keep CI sane; the
 * legacy benchmark ran 100k which takes minutes on Windows due to per-write
 * fsync).
 */
const N = process.env.TEDB_LARGE_N ? parseInt(process.env.TEDB_LARGE_N, 10) : 3000;

describe(`large scale (N=${N})`, () => {
    let storage: ElectronStorage;
    let rootDir: string;
    beforeAll(() => {
        rootDir = mkdtempSync(path.join(os.tmpdir(), 'tedb-large-'));
        storage = new ElectronStorage('largedb', 'largecol', rootDir);
    });
    afterAll(async () => {
        try {
            await storage.clear();
        } catch (e) {
            // best effort
        }
        rmSync(rootDir, {recursive: true, force: true});
    });

    test('bulk insert, keys, iterate, update, remove', async () => {
        const keyOf = (i: number) => `id${i}`;
        const docOf = (i: number, round = 0) => ({_id: keyOf(i), index: i, round, pad: 'x'.repeat(32)});

        const t0 = Date.now();
        await mapPool(Array.from({length: N}, (_, i) => i), 64, (i) =>
            storage.setItem(keyOf(i), docOf(i)),
        );
        const insertMs = Date.now() - t0;

        const t1 = Date.now();
        const keys = await storage.keys();
        const keysMs = Date.now() - t1;
        expect(keys.length).toBe(N);

        const t2 = Date.now();
        let seen = 0;
        await storage.iterate(() => {
            seen++;
        });
        const iterateMs = Date.now() - t2;
        expect(seen).toBe(N);

        // update every 10th document
        const updates = [] as Array<Promise<any>>;
        for (let i = 0; i < N; i += 10) {
            updates.push(storage.setItem(keyOf(i), docOf(i, 1)));
        }
        await Promise.all(updates);
        await expect(storage.getItem(keyOf(0))).resolves.toEqual(docOf(0, 1));

        // remove every 25th document
        const removals = [] as Array<Promise<any>>;
        for (let i = 0; i < N; i += 25) {
            removals.push(storage.removeItem(keyOf(i)));
        }
        await Promise.all(removals);
        const afterRemove = await storage.keys();
        expect(afterRemove.length).toBe(N - Math.ceil(N / 25));

        // no leftover temp files from the whole storm
        const collectionPath = path.join(rootDir, 'largedb', 'db', 'largecol');
        const strays = readdirSync(collectionPath).filter((f) => f.includes('.tmp'));
        expect(strays).toEqual([]);

        // eslint-disable-next-line no-console
        console.log(
            `[large-scale N=${N}] insert=${insertMs}ms keys=${keysMs}ms iterate=${iterateMs}ms`,
        );
    }, 600000);
});
