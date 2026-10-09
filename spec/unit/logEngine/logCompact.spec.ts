import * as fs from 'fs';
import * as path from 'path';
import {promises as fsp} from 'fs';
import {ElectronStorage} from '../../../src';
import {decodeRecordAt} from '../../../src/LogEngine/records';
import {
    setupStorage, teardownStorage, doc,
    logManifest, logSegmentsDir, ITestContext,
} from '../../helpers';

const readBoundaries = async (file: string): Promise<Array<{off: number; len: number; key: string; gen: number}>> => {
    const buf = await fsp.readFile(file);
    const recs: Array<{off: number; len: number; key: string; gen: number}> = [];
    let off = 0;
    while (off < buf.length) {
        const rec = decodeRecordAt(buf, off);
        recs.push({off, len: rec.recordLen, key: rec.key, gen: rec.gen});
        off += rec.recordLen;
    }
    return recs;
};

const segFiles = (ctx: ITestContext): string[] =>
    fs.readdirSync(logSegmentsDir(ctx)).sort().map((f) => path.join(logSegmentsDir(ctx), f));

const flipLastByte = async (file: string, rec: {off: number; len: number}): Promise<void> => {
    const fh = await fsp.open(file, 'r+');
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, rec.off + rec.len - 1);
    buf[0] ^= 0xff;
    await fh.write(buf, 0, 1, rec.off + rec.len - 1);
    await fh.close();
};

describe('log engine — segment rolling & compaction', () => {
    let ctx: ITestContext;
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('the active segment rolls once it outgrows segMaxBytes', async () => {
        ctx = setupStorage('testdb', 'testcol', {logSegMaxBytes: 200});
        for (let i = 1; i <= 10; i++) {
            await ctx.storage.setItem(`k${i}`, doc(`k${i}`, {payload: 'x'.repeat(20)}));
        }
        expect(segFiles(ctx).length).toBeGreaterThanOrEqual(2);
        for (let i = 1; i <= 10; i++) {
            await expect(ctx.storage.getItem(`k${i}`)).resolves.toEqual(doc(`k${i}`, {payload: 'x'.repeat(20)}));
        }
    });

    test('compaction reclaims dead records and keeps every live value', async () => {
        // ratio 0: every displaced generation triggers a compaction pass
        ctx = setupStorage('testdb', 'testcol', {
            logSegMaxBytes: 200,
            logCompactDeadRatio: 0,
            logCompactMinDeadBytes: 1,
        });
        for (let i = 1; i <= 5; i++) {
            await ctx.storage.setItem(`k${i}`, doc(`k${i}`, {v: 0}));
        }
        for (let round = 1; round <= 2; round++) {
            for (let i = 1; i <= 5; i++) {
                await ctx.storage.setItem(`k${i}`, doc(`k${i}`, {v: round}));
            }
        }
        // the last update scheduled a compaction; any read gates on it
        await ctx.storage.getItem('k1');

        expect(segFiles(ctx).length).toBeLessThanOrEqual(2);
        const manifest = JSON.parse(fs.readFileSync(logManifest(ctx), 'utf8'));
        expect(manifest.segments.length).toBeLessThanOrEqual(2);
        for (let i = 1; i <= 5; i++) {
            await expect(ctx.storage.getItem(`k${i}`)).resolves.toEqual(doc(`k${i}`, {v: 2}));
        }
        // the backup generation survives compaction (history: 1)
        const recs: Array<{key: string; gen: number}> = [];
        for (const file of segFiles(ctx)) {
            recs.push(...(await readBoundaries(file)).map((r) => ({key: r.key, gen: r.gen})));
        }
        const k1Gens = recs.filter((r) => r.key === 'k1').map((r) => r.gen).sort((a, b) => a - b);
        expect(k1Gens).toHaveLength(2);
        expect(k1Gens[1]).toBeGreaterThan(k1Gens[0]);
    });

    test('history 0: compaction keeps the current generation only', async () => {
        ctx = setupStorage('testdb', 'testcol', {
            logHistory: 0,
            logCompactDeadRatio: 0,
            logCompactMinDeadBytes: 1,
        });
        await ctx.storage.setItem('k1', doc('k1', {v: 1}));
        await ctx.storage.setItem('k1', doc('k1', {v: 2}));
        await ctx.storage.getItem('k1'); // settle the scheduled compaction

        const recs = await readBoundaries(segFiles(ctx)[0]);
        expect(recs).toHaveLength(1); // no backup generation retained

        // with no backup, a damaged current record means the key is gone
        await flipLastByte(segFiles(ctx)[0], recs[0]);
        const reopened = new ElectronStorage('testdb', 'testcol', ctx.rootDir, {logHistory: 0});
        await expect(reopened.getItem('k1')).resolves.toBeUndefined();
        await reopened.clear();
    });

    test('history 1: the backup still restores after compaction', async () => {
        ctx = setupStorage('testdb', 'testcol', {
            logCompactDeadRatio: 0,
            logCompactMinDeadBytes: 1,
        });
        await ctx.storage.setItem('k1', doc('k1', {v: 1}));
        await ctx.storage.setItem('k1', doc('k1', {v: 2}));
        await ctx.storage.getItem('k1'); // settle compaction

        const recs = await readBoundaries(segFiles(ctx)[0]);
        expect(recs).toHaveLength(2);
        await flipLastByte(segFiles(ctx)[0], recs[1]); // damage the current gen

        const reopened = new ElectronStorage('testdb', 'testcol', ctx.rootDir);
        await expect(reopened.getItem('k1')).resolves.toEqual(doc('k1', {v: 1}));
        await reopened.clear();
    });

    test('compaction promotes the previous generation when the current is damaged', async () => {
        ctx = setupStorage('testdb', 'testcol', {
            logCompactDeadRatio: 0,
            logCompactMinDeadBytes: 1,
        });
        await ctx.storage.setItem('k1', doc('k1', {v: 1}));
        await ctx.storage.setItem('k1', doc('k1', {v: 2}));
        await ctx.storage.getItem('k1'); // settle the first compaction

        const recs = await readBoundaries(segFiles(ctx)[0]);
        await flipLastByte(segFiles(ctx)[0], recs[1]); // current gen damaged
        // CRC damage is invisible to the dead-byte accounting, and with
        // history 1 an overwrite turns the displaced generation into the live
        // prev — the third write is what finally frees a record for the
        // compaction trigger
        await ctx.storage.setItem('k2', doc('k2', {n: 1}));
        await ctx.storage.setItem('k2', doc('k2', {n: 2}));
        await ctx.storage.setItem('k2', doc('k2', {n: 3}));
        await ctx.storage.getItem('k2'); // settle

        const reopened = new ElectronStorage('testdb', 'testcol', ctx.rootDir);
        await expect(reopened.getItem('k1')).resolves.toEqual(doc('k1', {v: 1})); // promoted
        await expect(reopened.getItem('k2')).resolves.toEqual(doc('k2', {n: 3}));
        await reopened.clear();
    });

    test('compaction drops a key whose both generations are damaged', async () => {
        ctx = setupStorage('testdb', 'testcol', {
            logCompactDeadRatio: 0,
            logCompactMinDeadBytes: 1,
        });
        await ctx.storage.setItem('k1', doc('k1', {v: 1}));
        await ctx.storage.setItem('k1', doc('k1', {v: 2}));
        await ctx.storage.getItem('k1'); // settle the first compaction

        const recs = await readBoundaries(segFiles(ctx)[0]);
        await flipLastByte(segFiles(ctx)[0], recs[0]);
        await flipLastByte(segFiles(ctx)[0], recs[1]); // both generations damaged
        await ctx.storage.setItem('k2', doc('k2', {n: 1}));
        await ctx.storage.setItem('k2', doc('k2', {n: 2}));
        await ctx.storage.setItem('k2', doc('k2', {n: 3}));
        await ctx.storage.getItem('k2'); // settle

        const reopened = new ElectronStorage('testdb', 'testcol', ctx.rootDir);
        await expect(reopened.getItem('k1')).resolves.toBeUndefined(); // dropped by compaction
        await expect(reopened.getItem('k2')).resolves.toEqual(doc('k2', {n: 3}));
        await reopened.clear();
    });

    test('segment count over the soft cap forces a compaction', async () => {
        ctx = setupStorage('testdb', 'testcol', {
            logSegMaxBytes: 20, // every record rolls a new segment
            logCompactDeadRatio: 0.99,
            logCompactMinDeadBytes: 10 * 1024 * 1024, // dead-ratio rule never fires
        });
        for (let i = 0; i < 130; i++) {
            await ctx.storage.setItem(`k${i}`, doc(`k${i}`, {i}));
        }
        await ctx.storage.getItem('k0'); // settle any forced compaction

        expect(segFiles(ctx).length).toBeLessThan(130);
        await expect(ctx.storage.getItem('k0')).resolves.toEqual(doc('k0', {i: 0}));
        await expect(ctx.storage.getItem('k129')).resolves.toEqual(doc('k129', {i: 129}));
    });
});
