import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import {ElectronStorage, TDurability} from '../../src';
import {doc} from '../helpers';

const N = 1000;

const runMode = async (durability: TDurability): Promise<{insertMs: number; updateMs: number; keyCount: number}> => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tedb-bench-'));
    const storage = new ElectronStorage('benchdb', 'benchcol', tmpRoot, {durability});

    let t0 = Date.now();
    for (let i = 0; i < N; i++) {
        await storage.setItem(`k${i}`, doc(`k${i}`, {payload: 'x'.repeat(64)}));
    }
    const insertMs = Date.now() - t0;

    t0 = Date.now();
    for (let i = 0; i < N; i++) {
        await storage.setItem(`k${i}`, doc(`k${i}`, {payload: 'y'.repeat(64)}));
    }
    const updateMs = Date.now() - t0;

    const keyCount = (await storage.keys()).length;
    await storage.clear();
    fs.rmSync(tmpRoot, {recursive: true, force: true});
    return {insertMs, updateMs, keyCount};
};

describe('bench: strict vs relaxed write throughput', () => {
    test('measures both modes and keeps data correct', async () => {
        const strict = await runMode('strict');
        const relaxed = await runMode('relaxed');

        expect(strict.keyCount).toBe(N);
        expect(relaxed.keyCount).toBe(N);

        // eslint-disable-next-line no-console
        console.log(
            `[bench N=${N}] strict: insert=${strict.insertMs}ms (${(strict.insertMs / N).toFixed(2)}ms/op) ` +
            `update=${strict.updateMs}ms (${(strict.updateMs / N).toFixed(2)}ms/op) | ` +
            `relaxed: insert=${relaxed.insertMs}ms (${(relaxed.insertMs / N).toFixed(2)}ms/op) ` +
            `update=${relaxed.updateMs}ms (${(relaxed.updateMs / N).toFixed(2)}ms/op) | ` +
            `speedup insert=${(strict.insertMs / relaxed.insertMs).toFixed(1)}x update=${(strict.updateMs / relaxed.updateMs).toFixed(1)}x`,
        );
    }, 300000);

    test('measures setItem hot-path dedup cost with 100k tracked keys', async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tedb-bench-keys-'));
        const storage = new ElectronStorage('benchdb', 'benchcol', tmpRoot, {durability: 'relaxed'});
        for (let i = 0; i < 100000; i++) {
            storage.trackKey(`k${i}`);
        }
        // relaxed: isolate the dedup cost from fsync noise
        const t0 = Date.now();
        for (let i = 0; i < 1000; i++) {
            await storage.setItem(`k${i}`, doc(`k${i}`));
        }
        const updateMs = Date.now() - t0;
        await storage.clear();
        fs.rmSync(tmpRoot, {recursive: true, force: true});
        // eslint-disable-next-line no-console
        console.log(`[bench keys=100k] 1000 updates with 100k tracked keys: ${updateMs}ms (${(updateMs / 1000).toFixed(2)}ms/op, dedup is O(1) via Set)`);
    }, 300000);
});
