import * as fs from 'fs';
import * as path from 'path';
import {ElectronStorage} from '../../../src';
import {
    setupStorage, teardownStorage, doc, readJsonFile, fileExists,
    logManifest, logSegmentsDir, EMPTY_INDEX, nonEmptyIndex, ITestContext,
} from '../../helpers';

describe('log engine — driver CRUD', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage('testdb', 'testcol');
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('set/get round-trips documents including unicode and nesting', async () => {
        const v = doc('k1', {name: '單詞-📝', nested: {a: [1, 2, {b: true}]}});
        await expect(ctx.storage.setItem('k1', v)).resolves.toEqual(v);
        await expect(ctx.storage.getItem('k1')).resolves.toEqual(v);
    });

    test('setItem resolves the original value (files-engine contract)', async () => {
        const v = doc('k1');
        await expect(ctx.storage.setItem('k1', v)).resolves.toEqual(v);
    });

    test('overwrite keeps the latest generation visible', async () => {
        await ctx.storage.setItem('k1', doc('k1', {v: 1}));
        await ctx.storage.setItem('k1', doc('k1', {v: 2}));
        await expect(ctx.storage.getItem('k1')).resolves.toEqual(doc('k1', {v: 2}));
    });

    test('removeItem drops the key and tolerates repeats', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        await expect(ctx.storage.removeItem('k1')).resolves.toBeNull();
        await expect(ctx.storage.getItem('k1')).resolves.toBeUndefined();
        await expect(ctx.storage.removeItem('k1')).resolves.toBeNull();
        expect(ctx.storage.allKeys).toEqual([]);
        // the key is writable again afterwards
        await ctx.storage.setItem('k1', doc('k1', {again: true}));
        await expect(ctx.storage.getItem('k1')).resolves.toEqual(doc('k1', {again: true}));
    });

    test('getItem on a never-written key resolves undefined and untracks', async () => {
        await expect(ctx.storage.getItem('ghost')).resolves.toBeUndefined();
        ctx.storage.trackKey('ghost');
        await ctx.storage.getItem('ghost');
        expect(ctx.storage.allKeys).toEqual([]);
    });

    test('keys() mirrors the keydir', async () => {
        await ctx.storage.setItem('b', doc('b'));
        await ctx.storage.setItem('a', doc('a'));
        expect((await ctx.storage.keys()).sort()).toEqual(['a', 'b']);
        expect(ctx.storage.allKeys.sort()).toEqual(['a', 'b']);
    });

    test('iterate feeds (value, key), breaks on truthy, skips docs without _id', async () => {
        await ctx.storage.setItem('k1', doc('k1', {n: 1}));
        await ctx.storage.setItem('k2', doc('k2', {n: 2}));
        await ctx.storage.setItem('noId', {nope: true}); // parses fine, no _id

        const seen: Array<[string, string]> = [];
        await ctx.storage.iterate((value, key) => {
            seen.push([key, value._id]);
        });
        expect(seen.sort()).toEqual([['k1', 'k1'], ['k2', 'k2']]);

        const firstOnly: string[] = [];
        await ctx.storage.iterate((value) => {
            firstOnly.push(value._id);
            return true; // break after the first document
        });
        expect(firstOnly).toHaveLength(1);
    });

    test('exists is a zero-IO keydir probe with the files-engine shape', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        const hit = await ctx.storage.exists({key: 'k1', value: 'k1'}, null, 'name');
        expect(hit).toEqual({key: 'k1', value: 'k1', doesExist: true, index: null, fieldName: 'name'});
        const miss = await ctx.storage.exists({key: 'nope', value: 'nope'}, null, 'name');
        expect(miss.doesExist).toBe(false);
    });

    test('indexes: round-trip, empty placeholder, never-stored, removal', async () => {
        const p = nonEmptyIndex();
        await ctx.storage.storeIndex('name', p);
        await ctx.storage.storeIndex('name', nonEmptyIndex(['id2', 'id3'])); // update
        await expect(ctx.storage.fetchIndex('name')).resolves.toEqual(JSON.parse(nonEmptyIndex(['id2', 'id3'])));

        await ctx.storage.storeIndex('email', EMPTY_INDEX);
        await expect(ctx.storage.fetchIndex('email')).resolves.toBeNull();

        await expect(ctx.storage.fetchIndex('ghost')).resolves.toBeUndefined();

        await ctx.storage.removeIndex('name');
        await expect(ctx.storage.fetchIndex('name')).resolves.toBeUndefined();
    });

    test('collectionSanitize drops keys tedb does not know', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        await ctx.storage.setItem('k2', doc('k2'));
        await expect(ctx.storage.collectionSanitize(['k1'])).resolves.toBeNull();
        await expect(ctx.storage.getItem('k1')).resolves.toEqual(doc('k1'));
        await expect(ctx.storage.getItem('k2')).resolves.toBeUndefined();
        expect(ctx.storage.allKeys).toEqual(['k1']);
    });

    test('clear wipes state and the instance stays usable', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        await expect(ctx.storage.clear()).resolves.toBeNull();
        expect((await ctx.storage.keys())).toEqual([]);
        expect(fileExists(logManifest(ctx))).toBe(true); // fresh manifest rebuilt
        await ctx.storage.setItem('k2', doc('k2'));
        await expect(ctx.storage.getItem('k2')).resolves.toEqual(doc('k2'));
    });

    test('state survives reopening a new instance on the same directory', async () => {
        await ctx.storage.setItem('k1', doc('k1', {v: 1}));
        await ctx.storage.setItem('k2', doc('k2', {v: 2}));
        await ctx.storage.removeItem('k1'); // tombstone must survive too

        const reopened = new ElectronStorage('testdb', 'testcol', ctx.rootDir);
        await expect(reopened.keys()).resolves.toEqual(['k2']);
        await expect(reopened.getItem('k1')).resolves.toBeUndefined();
        await expect(reopened.getItem('k2')).resolves.toEqual(doc('k2', {v: 2}));
        // generations keep rising after a reopen (no gen reuse)
        await reopened.setItem('k2', doc('k2', {v: 3}));
        await expect(reopened.getItem('k2')).resolves.toEqual(doc('k2', {v: 3}));
        await reopened.clear();
    });

    test('manifest records the owning pid and engine', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        const manifest = JSON.parse(fs.readFileSync(logManifest(ctx), 'utf8'));
        expect(manifest.engine).toBe('log');
        expect(manifest.pid).toBe(process.pid);
        expect(Array.isArray(manifest.segments)).toBe(true);
    });

    test('relaxed durability round-trips', async () => {
        await teardownStorage(ctx);
        ctx = setupStorage('testdb', 'testcol', {durability: 'relaxed'});
        await ctx.storage.setItem('k1', doc('k1', {v: 1}));
        await ctx.storage.setItem('k1', doc('k1', {v: 2}));
        await expect(ctx.storage.getItem('k1')).resolves.toEqual(doc('k1', {v: 2}));
        const reopened = new ElectronStorage('testdb', 'testcol', ctx.rootDir, {durability: 'relaxed'});
        await expect(reopened.getItem('k1')).resolves.toEqual(doc('k1', {v: 2}));
        await reopened.clear();
    });

    test('relaxed durability still syncs at least once per fallback interval', async () => {
        await teardownStorage(ctx);
        ctx = setupStorage('testdb', 'testcol', {durability: 'relaxed'});
        await ctx.storage.setItem('k1', doc('k1', {v: 1}));
        // the 1s bounded-loss-window fallback fires on the first write after
        // the interval has passed
        await new Promise<void>((res) => setTimeout(res, 1100));
        await ctx.storage.setItem('k2', doc('k2'));
        await expect(ctx.storage.getItem('k2')).resolves.toEqual(doc('k2'));
    }, 15000);

    test('clear while a compaction is in flight waits for it', async () => {
        await teardownStorage(ctx);
        ctx = setupStorage('testdb', 'testcol', {
            logCompactDeadRatio: 0,
            logCompactMinDeadBytes: 1,
        });
        await ctx.storage.setItem('k1', doc('k1', {v: 1}));
        await ctx.storage.setItem('k1', doc('k1', {v: 2})); // schedules a compaction
        await expect(ctx.storage.clear()).resolves.toBeNull();
        expect((await ctx.storage.keys())).toEqual([]);
        await ctx.storage.setItem('k2', doc('k2'));
        await expect(ctx.storage.getItem('k2')).resolves.toEqual(doc('k2'));
    });

    test('concurrent writers to the same key end up readable (read-your-write)', async () => {
        const writes = Array.from({length: 50}, (_, i) => ctx.storage.setItem('hot', doc('hot', {writer: i})));
        await Promise.all(writes);
        const final = await ctx.storage.getItem('hot');
        expect(final._id).toBe('hot');
        expect(final.writer).toBeLessThan(50);

        // distinct keys in parallel, then all must be readable
        await Promise.all(Array.from({length: 30}, (_, i) => ctx.storage.setItem(`k${i}`, doc(`k${i}`, {i}))));
        const keys = await ctx.storage.keys();
        expect(keys).toHaveLength(31); // hot + k0..k29
        for (let i = 0; i < 30; i++) {
            await expect(ctx.storage.getItem(`k${i}`)).resolves.toEqual(doc(`k${i}`, {i}));
        }
    });

    test('log collections never create the files-engine states skeleton', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        expect(fileExists(path.join(ctx.collectionPath, '`v0.0.1'))).toBe(false);
        expect(fs.existsSync(logSegmentsDir(ctx))).toBe(true);
    });
});
