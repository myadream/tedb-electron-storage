import * as fs from 'fs';
import * as path from 'path';
import {promises as fsp} from 'fs';
import {spawn} from 'child_process';
import {ElectronStorage} from '../../../src';
import {decodeRecordAt} from '../../../src/LogEngine/records';
import {encodeRecord} from '../../../src/LogEngine/records';
import {
    setupStorage, teardownStorage, doc, fileExists,
    logManifest, logSegmentsDir, ITestContext,
} from '../../helpers';

const sleep = (ms: number): Promise<void> => new Promise<void>((res) => setTimeout(res, ms));

interface IBoundary {
    off: number;
    len: number;
    key: string;
    gen: number;
}

/** Decode the record boundaries of a segment file. */
const readBoundaries = async (file: string): Promise<IBoundary[]> => {
    const buf = await fsp.readFile(file);
    const recs: IBoundary[] = [];
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

const flipLastByte = async (file: string, rec: IBoundary): Promise<void> => {
    const fh = await fsp.open(file, 'r+');
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, rec.off + rec.len - 1);
    buf[0] ^= 0xff;
    await fh.write(buf, 0, 1, rec.off + rec.len - 1);
    await fh.close();
};

const LOG_OPTS = {};

describe('log engine — crash & corruption recovery', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage('testdb', 'testcol', LOG_OPTS);
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('golden truncation matrix: a torn tail keeps every complete record', async () => {
        for (let cut = 1; cut <= 5; cut++) {
            const c = setupStorage('testdb', 'testcol', LOG_OPTS);
            for (let i = 1; i <= 5; i++) {
                await c.storage.setItem(`k${i}`, doc(`k${i}`, {i}));
            }
            const segFile = segFiles(c)[0];
            const recs = await readBoundaries(segFile);
            expect(recs).toHaveLength(5);
            // tear inside record `cut`: it and everything after must vanish
            await fsp.truncate(segFile, recs[cut - 1].off + Math.floor(recs[cut - 1].len / 2));

            const reopened = new ElectronStorage('testdb', 'testcol', c.rootDir, LOG_OPTS);
            const expected = Array.from({length: cut - 1}, (_, i) => `k${i + 1}`).sort();
            await expect(reopened.keys()).resolves.toEqual(expected);
            for (const key of expected) {
                await expect(reopened.getItem(key)).resolves.toEqual(doc(key, {i: Number(key.slice(1))}));
            }
            await reopened.clear();
            await teardownStorage(c);
        }
    });

    test('random garbage appended to the segment is truncated away', async () => {
        for (let i = 1; i <= 3; i++) {
            await ctx.storage.setItem(`k${i}`, doc(`k${i}`));
        }
        const segFile = segFiles(ctx)[0];
        const recs = await readBoundaries(segFile);
        const goodEnd = recs[recs.length - 1].off + recs[recs.length - 1].len;
        await fsp.appendFile(segFile, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]));

        const reopened = new ElectronStorage('testdb', 'testcol', ctx.rootDir, LOG_OPTS);
        await expect(reopened.keys()).resolves.toEqual(['k1', 'k2', 'k3']);
        expect((await fsp.stat(segFile)).size).toBe(goodEnd); // tail cut back
        await reopened.clear();
    });

    test('damaged current record while open -> repaired from the previous generation', async () => {
        await ctx.storage.setItem('k1', doc('k1', {v: 1}));
        await ctx.storage.setItem('k1', doc('k1', {v: 2}));
        const recs = await readBoundaries(segFiles(ctx)[0]);
        await flipLastByte(segFiles(ctx)[0], recs[1]); // damage the current gen

        await expect(ctx.storage.getItem('k1')).resolves.toEqual(doc('k1', {v: 1}));
        // the repair appended a fresh generation — readable and durable
        await expect(ctx.storage.getItem('k1')).resolves.toEqual(doc('k1', {v: 1}));
    });

    test('iterate repairs damaged records through the per-key queue', async () => {
        await ctx.storage.setItem('k1', doc('k1', {v: 1}));
        await ctx.storage.setItem('k1', doc('k1', {v: 2}));
        const recs = await readBoundaries(segFiles(ctx)[0]);
        await flipLastByte(segFiles(ctx)[0], recs[1]);

        const seen: any[] = [];
        await ctx.storage.iterate((value) => {
            seen.push(value);
        });
        expect(seen).toEqual([doc('k1', {v: 1})]);
    });

    test('iterate skips keys the repair path had to drop', async () => {
        await ctx.storage.setItem('k1', doc('k1', {v: 1}));
        await ctx.storage.setItem('k1', doc('k1', {v: 2}));
        await ctx.storage.setItem('k2', doc('k2', {v: 3}));
        const recs = await readBoundaries(segFiles(ctx)[0]);
        await flipLastByte(segFiles(ctx)[0], recs[0]); // damage both k1 generations
        await flipLastByte(segFiles(ctx)[0], recs[1]);

        const seen: any[] = [];
        await ctx.storage.iterate((value) => {
            seen.push(value);
        });
        expect(seen).toEqual([doc('k2', {v: 3})]);
        await expect(ctx.storage.getItem('k1')).resolves.toBeUndefined();
    });

    test('both generations damaged -> the key is dropped', async () => {
        await ctx.storage.setItem('k1', doc('k1', {v: 1}));
        await ctx.storage.setItem('k1', doc('k1', {v: 2}));
        const recs = await readBoundaries(segFiles(ctx)[0]);
        await flipLastByte(segFiles(ctx)[0], recs[0]);
        await flipLastByte(segFiles(ctx)[0], recs[1]);

        await expect(ctx.storage.getItem('k1')).resolves.toBeUndefined();
        await expect(ctx.storage.keys()).resolves.toEqual([]);
    });

    test('an intact record with unparseable JSON is treated as damage', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        // craft a crc-valid record whose payload is not JSON
        const forged = encodeRecord('bad', 'not-json', 999);
        await fsp.appendFile(segFiles(ctx)[0], forged);

        const reopened = new ElectronStorage('testdb', 'testcol', ctx.rootDir, LOG_OPTS);
        await expect(reopened.getItem('bad')).resolves.toBeUndefined();
        await expect(reopened.keys()).resolves.toEqual(['k1']);
        await reopened.clear();
    });

    test('a missing manifest triggers a full rebuild', async () => {
        await ctx.storage.setItem('k1', doc('k1', {v: 1}));
        await ctx.storage.setItem('k2', doc('k2', {v: 2}));
        await ctx.storage.removeItem('k1');
        fs.rmSync(logManifest(ctx));

        const reopened = new ElectronStorage('testdb', 'testcol', ctx.rootDir, LOG_OPTS);
        await expect(reopened.keys()).resolves.toEqual(['k2']);
        await expect(reopened.getItem('k2')).resolves.toEqual(doc('k2', {v: 2}));
        await reopened.clear();
    });

    test('a corrupt manifest triggers a full rebuild', async () => {
        await ctx.storage.setItem('k1', doc('k1', {v: 1}));
        fs.writeFileSync(logManifest(ctx), '###corrupted###', 'utf8');

        const reopened = new ElectronStorage('testdb', 'testcol', ctx.rootDir, LOG_OPTS);
        await expect(reopened.keys()).resolves.toEqual(['k1']);
        await expect(reopened.getItem('k1')).resolves.toEqual(doc('k1', {v: 1}));
        await reopened.clear();
    });

    test('orphan segments (absent from the manifest) are removed on open', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        const orphan = path.join(logSegmentsDir(ctx), 'seg-000009.log');
        fs.writeFileSync(orphan, 'never committed', 'utf8');

        const reopened = new ElectronStorage('testdb', 'testcol', ctx.rootDir, LOG_OPTS);
        await expect(reopened.keys()).resolves.toEqual(['k1']);
        expect(fileExists(orphan)).toBe(false);
        await reopened.clear();
    });

    test('a manifest held by a live foreign process refuses to open; a dead one is taken over', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        // a live process that is not us
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {stdio: 'ignore'});
        try {
            const foreign = JSON.parse(fs.readFileSync(logManifest(ctx), 'utf8'));
            foreign.pid = child.pid;
            fs.writeFileSync(logManifest(ctx), JSON.stringify(foreign), 'utf8');

            const refused = new ElectronStorage('testdb', 'testcol', ctx.rootDir, LOG_OPTS);
            await expect(refused.keys()).rejects.toThrow(/collectionInUse/);

            child.kill();
            for (let i = 0; i < 40; i++) {
                let alive = true;
                try {
                    process.kill(child.pid!, 0);
                } catch (e: any) {
                    alive = e.code === 'EPERM';
                }
                if (!alive) break;
                await sleep(50);
            }

            const takeover = new ElectronStorage('testdb', 'testcol', ctx.rootDir, LOG_OPTS);
            await expect(takeover.keys()).resolves.toEqual(['k1']);
            // the takeover rewrote the manifest with our own pid
            expect(JSON.parse(fs.readFileSync(logManifest(ctx), 'utf8')).pid).toBe(process.pid);
            await takeover.clear();
        } finally {
            child.kill();
        }
    });
});
