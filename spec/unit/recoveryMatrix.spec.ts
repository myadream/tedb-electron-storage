/**
 * Durability recovery matrix for the whole driver family: every combination
 * of (base file state x backup directory state x backup file state) that the
 * recovery helpers in GetItem / Keys / Iterate / FetchIndex / SetItem /
 * StoreIndex branch on. Layout on disk:
 *
 *   <collectionPath>/<key>.db                     current data ("base")
 *   <collectionPath>/`v0.0.1/states/<key>/past    previous data ("backup")
 *   <collectionPath>/index_<key>.db               index base
 *   <collectionPath>/`v0.0.1/states/index_<key>/past  index backup
 */
import {ElectronStorage} from '../../src';
import {
    setupStorage, teardownStorage, baseFile, pastFile, indexBaseFile, indexPastFile,
    readJsonFile, fileExists, corruptFile, doc, removePath, writeRaw,
    EMPTY_INDEX, nonEmptyIndex, ITestContext,
} from '../helpers';
import * as path from 'path';
import {readFileSync} from 'fs';

/** two versions on disk so the backup holds a distinct payload */
const seedTwoVersions = async (ctx: ITestContext, key = 'k1') => {
    await ctx.storage.setItem(key, doc(key, {v: 1}));
    await ctx.storage.setItem(key, doc(key, {v: 2}));
    return {v1: doc(key, {v: 1}), v2: doc(key, {v: 2})};
};

/** two storeIndex calls so the backup dir + past file actually exist (lazyBackup writes base only on the first store) */
const seedTwoIndexVersions = async (ctx: ITestContext, key = 'i1') => {
    await ctx.storage.storeIndex(key, nonEmptyIndex());
    await ctx.storage.storeIndex(key, nonEmptyIndex());
};

describe('recovery matrix — getItem', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage();
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('base missing + backup corrupted -> key dropped, backup dir removed', async () => {
        await seedTwoVersions(ctx);
        removePath(baseFile(ctx, 'k1'));
        corruptFile(pastFile(ctx, 'k1'));

        await expect(ctx.storage.getItem('k1')).resolves.toBeUndefined();
        expect(fileExists(pastFile(ctx, 'k1'))).toBe(false);
        expect(fileExists(path.join(ctx.statesPath, 'k1'))).toBe(false);
        expect(ctx.storage.allKeys).not.toContain('k1');
    });

    test('base missing + backup dir exists but past file gone -> key dropped, dir removed', async () => {
        await seedTwoVersions(ctx);
        removePath(baseFile(ctx, 'k1'));
        removePath(pastFile(ctx, 'k1'));

        await expect(ctx.storage.getItem('k1')).resolves.toBeUndefined();
        expect(fileExists(path.join(ctx.statesPath, 'k1'))).toBe(false);
        expect(ctx.storage.allKeys).not.toContain('k1');
    });

    test('base corrupted + no backup directory -> key dropped, base removed', async () => {
        await ctx.storage.setItem('k1', doc('k1', {v: 1}));
        removePath(path.join(ctx.statesPath, 'k1')); // no backup at all
        corruptFile(baseFile(ctx, 'k1'));

        await expect(ctx.storage.getItem('k1')).resolves.toBeUndefined();
        expect(fileExists(baseFile(ctx, 'k1'))).toBe(false);
        expect(ctx.storage.allKeys).not.toContain('k1');
    });

    test('base corrupted + backup dir exists but past file gone -> both removed', async () => {
        await seedTwoVersions(ctx);
        corruptFile(baseFile(ctx, 'k1'));
        removePath(pastFile(ctx, 'k1'));

        await expect(ctx.storage.getItem('k1')).resolves.toBeUndefined();
        expect(fileExists(baseFile(ctx, 'k1'))).toBe(false);
        expect(fileExists(path.join(ctx.statesPath, 'k1'))).toBe(false);
        expect(ctx.storage.allKeys).not.toContain('k1');
    });
});

describe('recovery matrix — setItem backup-directory branches', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage();
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('base exists + backup dir missing -> dir recreated, base copied to past, new data written', async () => {
        const {v1} = await seedTwoVersions(ctx);
        removePath(path.join(ctx.statesPath, 'k1')); // simulate lost backup dir

        const v3 = doc('k1', {v: 3});
        await ctx.storage.setItem('k1', v3);
        expect(readJsonFile(baseFile(ctx, 'k1'))).toEqual(v3);
        // the copy fell back to the only surviving version: v1 was in the
        // deleted past, so the recreated past holds the pre-write base (v2)
        expect(readJsonFile(pastFile(ctx, 'k1'))).not.toEqual(v1);
        expect(readJsonFile(pastFile(ctx, 'k1'))).toEqual(doc('k1', {v: 2}));
    });

    test('base missing + backup dir exists -> new payload written to both locations', async () => {
        await seedTwoVersions(ctx);
        removePath(baseFile(ctx, 'k1'));

        const v3 = doc('k1', {v: 3});
        await ctx.storage.setItem('k1', v3);
        expect(readJsonFile(baseFile(ctx, 'k1'))).toEqual(v3);
        expect(readJsonFile(pastFile(ctx, 'k1'))).toEqual(v3);
    });
});

describe('recovery matrix — fetchIndex', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage();
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('index never stored -> resolves undefined', async () => {
        await expect(ctx.storage.fetchIndex('nope')).resolves.toBeUndefined();
    });

    test('base missing + no backup dir -> undefined', async () => {
        await ctx.storage.storeIndex('i1', nonEmptyIndex());
        removePath(indexBaseFile(ctx, 'i1'));
        removePath(path.join(ctx.statesPath, 'index_i1'));
        await expect(ctx.storage.fetchIndex('i1')).resolves.toBeUndefined();
    });

    test('base missing + backup dir exists but past gone -> null, dir removed', async () => {
        await seedTwoIndexVersions(ctx);
        removePath(indexBaseFile(ctx, 'i1'));
        removePath(indexPastFile(ctx, 'i1'));

        await expect(ctx.storage.fetchIndex('i1')).resolves.toBeNull();
        expect(fileExists(path.join(ctx.statesPath, 'index_i1'))).toBe(false);
    });

    test('base missing + past corrupted -> null, backup removed', async () => {
        await seedTwoIndexVersions(ctx);
        removePath(indexBaseFile(ctx, 'i1'));
        corruptFile(indexPastFile(ctx, 'i1'));

        await expect(ctx.storage.fetchIndex('i1')).resolves.toBeNull();
        expect(fileExists(path.join(ctx.statesPath, 'index_i1'))).toBe(false);
    });

    test('base missing + past holds the empty placeholder -> null, backup removed', async () => {
        await seedTwoIndexVersions(ctx);
        removePath(indexBaseFile(ctx, 'i1'));
        writeRaw(indexPastFile(ctx, 'i1'), EMPTY_INDEX);

        await expect(ctx.storage.fetchIndex('i1')).resolves.toBeNull();
        expect(fileExists(path.join(ctx.statesPath, 'index_i1'))).toBe(false);
    });

    test('base missing + non-empty past -> index restored into base and returned', async () => {
        await seedTwoIndexVersions(ctx);
        removePath(indexBaseFile(ctx, 'i1'));

        const expected = JSON.parse(nonEmptyIndex());
        await expect(ctx.storage.fetchIndex('i1')).resolves.toEqual(expected);
        expect(readJsonFile(indexBaseFile(ctx, 'i1'))).toEqual(expected);
    });

    test('base corrupted + no backup dir -> null, base removed', async () => {
        await ctx.storage.storeIndex('i1', nonEmptyIndex());
        removePath(path.join(ctx.statesPath, 'index_i1'));
        corruptFile(indexBaseFile(ctx, 'i1'));

        await expect(ctx.storage.fetchIndex('i1')).resolves.toBeNull();
        expect(fileExists(indexBaseFile(ctx, 'i1'))).toBe(false);
    });

    test('base corrupted + backup dir exists but past gone -> both removed', async () => {
        await seedTwoIndexVersions(ctx);
        corruptFile(indexBaseFile(ctx, 'i1'));
        removePath(indexPastFile(ctx, 'i1'));

        await expect(ctx.storage.fetchIndex('i1')).resolves.toBeNull();
        expect(fileExists(indexBaseFile(ctx, 'i1'))).toBe(false);
        expect(fileExists(path.join(ctx.statesPath, 'index_i1'))).toBe(false);
    });

    test('base corrupted + past corrupted -> both removed', async () => {
        await seedTwoIndexVersions(ctx);
        corruptFile(indexBaseFile(ctx, 'i1'));
        corruptFile(indexPastFile(ctx, 'i1'));

        await expect(ctx.storage.fetchIndex('i1')).resolves.toBeNull();
        expect(fileExists(indexBaseFile(ctx, 'i1'))).toBe(false);
        expect(fileExists(path.join(ctx.statesPath, 'index_i1'))).toBe(false);
    });

    test('base corrupted + past holds the empty placeholder -> both removed', async () => {
        await seedTwoIndexVersions(ctx);
        corruptFile(indexBaseFile(ctx, 'i1'));
        writeRaw(indexPastFile(ctx, 'i1'), EMPTY_INDEX);

        await expect(ctx.storage.fetchIndex('i1')).resolves.toBeNull();
        expect(fileExists(indexBaseFile(ctx, 'i1'))).toBe(false);
        expect(fileExists(path.join(ctx.statesPath, 'index_i1'))).toBe(false);
    });
});

describe('recovery matrix — storeIndex directory branches', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage();
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('empty index on a fresh key -> no base file, only the backup holds it', async () => {
        await ctx.storage.storeIndex('i1', EMPTY_INDEX);
        expect(fileExists(indexBaseFile(ctx, 'i1'))).toBe(false);
        expect(readRawOrNull(indexPastFile(ctx, 'i1'))).toBe(EMPTY_INDEX);
    });

    test('base exists + backup dir missing + storing empty -> base removed, dir recreated with empty', async () => {
        await ctx.storage.storeIndex('i1', nonEmptyIndex());
        removePath(path.join(ctx.statesPath, 'index_i1'));

        await ctx.storage.storeIndex('i1', EMPTY_INDEX);
        expect(fileExists(indexBaseFile(ctx, 'i1'))).toBe(false);
        expect(readRawOrNull(indexPastFile(ctx, 'i1'))).toBe(EMPTY_INDEX);
    });

    test('base missing + backup dir exists + storing empty -> only the backup rewritten', async () => {
        await seedTwoIndexVersions(ctx);
        removePath(indexBaseFile(ctx, 'i1'));

        await ctx.storage.storeIndex('i1', EMPTY_INDEX);
        expect(fileExists(indexBaseFile(ctx, 'i1'))).toBe(false);
        expect(readRawOrNull(indexPastFile(ctx, 'i1'))).toBe(EMPTY_INDEX);
    });

    test('base missing + backup dir exists + storing non-empty -> new payload in both', async () => {
        await seedTwoIndexVersions(ctx);
        removePath(indexBaseFile(ctx, 'i1'));

        const fresh = nonEmptyIndex(['id2', 'id3']);
        await ctx.storage.storeIndex('i1', fresh);
        expect(readJsonFile(indexBaseFile(ctx, 'i1'))).toEqual(JSON.parse(fresh));
        expect(readRawOrNull(indexPastFile(ctx, 'i1'))).toBe(fresh);
    });

    test('base missing + backup dir missing + storing non-empty (lazy first store) -> base only, no backup dir', async () => {
        const fresh = nonEmptyIndex();
        await ctx.storage.storeIndex('i1', fresh);
        expect(readJsonFile(indexBaseFile(ctx, 'i1'))).toEqual(JSON.parse(fresh));
        expect(fileExists(path.join(ctx.statesPath, 'index_i1'))).toBe(false);
    });
});

describe('recovery matrix — keys', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage();
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('corrupted base + missing backup dir -> key purged on scan (fresh instance)', async () => {
        await seedTwoVersions(ctx);
        corruptFile(baseFile(ctx, 'k1'));
        removePath(path.join(ctx.statesPath, 'k1'));

        const reopened = new ElectronStorage('testdb', 'testcol', ctx.rootDir);
        await expect(reopened.keys()).resolves.toEqual([]);
        expect(fileExists(baseFile(ctx, 'k1'))).toBe(false); // garbage removed
    });

    test('a doc file on disk unknown to the cache forces a rescan and surfaces', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        writeRaw(baseFile(ctx, 'k2'), JSON.stringify(doc('k2')));

        const keys = await ctx.storage.keys();
        expect(keys.sort()).toEqual(['k1', 'k2']);
    });

    test('replaced doc file (same count, different key) still busts the cache', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        // cache says [k1]; disk says [k2] — sizes match, contents do not.
        // keys are read from the payload's _id, the filename is only a filter.
        removePath(baseFile(ctx, 'k1'));
        removePath(path.join(ctx.statesPath, 'k1'));
        writeRaw(baseFile(ctx, 'k2'), JSON.stringify(doc('k2')));

        const keys = await ctx.storage.keys();
        // rescan result is merged with the in-memory cache
        expect(keys.sort()).toEqual(['k1', 'k2']);
    });

    test('collection directory removed + empty cache -> empty list', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        ctx.storage.allKeys.length = 0; // force the disk-scan path
        removePath(path.join(ctx.collectionPath));
        await expect(ctx.storage.keys()).resolves.toEqual([]);
    });

    test('collection directory removed + populated cache -> empty list', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        removePath(path.join(ctx.collectionPath));
        await expect(ctx.storage.keys()).resolves.toEqual([]);
    });
});

describe('recovery matrix — iterate', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage();
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('base corrupted + backup dir exists but past gone -> purged, no callback', async () => {
        await seedTwoVersions(ctx);
        corruptFile(baseFile(ctx, 'k1'));
        removePath(pastFile(ctx, 'k1'));

        const seen: any[] = [];
        await ctx.storage.iterate((value) => {
            seen.push(value);
        });
        expect(seen).toEqual([]);
        expect(fileExists(baseFile(ctx, 'k1'))).toBe(false);
        expect(fileExists(path.join(ctx.statesPath, 'k1'))).toBe(false);
    });

    test('base corrupted + no backup directory -> base removed, no callback', async () => {
        await ctx.storage.setItem('k1', doc('k1', {v: 1}));
        removePath(path.join(ctx.statesPath, 'k1'));
        corruptFile(baseFile(ctx, 'k1'));

        const seen: any[] = [];
        await ctx.storage.iterate((value) => {
            seen.push(value);
        });
        expect(seen).toEqual([]);
        expect(fileExists(baseFile(ctx, 'k1'))).toBe(false);
    });

    test('parsable document without _id is skipped silently', async () => {
        writeRaw(baseFile(ctx, 'noId'), '{"name":"ghost"}');
        const seen: any[] = [];
        await ctx.storage.iterate((value) => {
            seen.push(value);
        });
        expect(seen).toEqual([]);
    });

    test('backup document without _id is restored to base but not iterated', async () => {
        await seedTwoVersions(ctx);
        writeRaw(pastFile(ctx, 'k1'), '{"name":"ghost"}');
        corruptFile(baseFile(ctx, 'k1'));

        const seen: any[] = [];
        await ctx.storage.iterate((value) => {
            seen.push(value);
        });
        expect(seen).toEqual([]);
        // the parsable backup was still copied over the corrupted base
        expect(readJsonFile(baseFile(ctx, 'k1'))).toEqual({name: 'ghost'});
    });
});

function readRawOrNull(p: string): string | null {
    return fileExists(p) ? readFileSync(p, 'utf8') : null;
}
