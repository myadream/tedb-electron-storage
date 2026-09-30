/**
 * Exists() backup-recovery matrix. Exists is the driver's non-destructive
 * "is this key alive" probe: unlike GetItem it never resurrects data, it only
 * removes backup files that are provably garbage. Every branch below was
 * previously uncovered.
 */
import {
    setupStorage, teardownStorage, baseFile, pastFile, readJsonFile, fileExists,
    corruptFile, doc, removePath, ITestContext,
} from '../helpers';
import * as path from 'path';

describe('StorageDriver.exists — backup matrix', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage();
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    const existsK1 = () => ctx.storage.exists({key: 'k1', value: 'k1'}, null, 'name');

    test('base missing + no backup directory -> false, nothing created', async () => {
        const res = await existsK1();
        expect(res).toEqual({key: 'k1', value: 'k1', doesExist: false, index: null, fieldName: 'name'});
        expect(fileExists(baseFile(ctx, 'k1'))).toBe(false);
    });

    test('base missing + parsable backup -> true without moving any file', async () => {
        const v1 = doc('k1', {name: 'alice'});
        const v2 = doc('k1', {name: 'bob'});
        await ctx.storage.setItem('k1', v1);
        await ctx.storage.setItem('k1', v2);
        removePath(baseFile(ctx, 'k1'));

        const res = await existsK1();
        expect(res.doesExist).toBe(true);
        // exists must not resurrect: the base stays missing, the backup intact
        expect(fileExists(baseFile(ctx, 'k1'))).toBe(false);
        expect(readJsonFile(pastFile(ctx, 'k1'))).toEqual(v1);
    });

    test('base missing + unparsable backup -> false and backup removed', async () => {
        await ctx.storage.setItem('k1', doc('k1', {n: 1}));
        await ctx.storage.setItem('k1', doc('k1', {n: 2}));
        removePath(baseFile(ctx, 'k1'));
        corruptFile(pastFile(ctx, 'k1'));

        const res = await existsK1();
        expect(res.doesExist).toBe(false);
        // proven-garbage backup is deleted (past file and its directory)
        expect(fileExists(pastFile(ctx, 'k1'))).toBe(false);
        expect(fileExists(ctx.statesPath)).toBe(true); // sibling state untouched
    });

    test('base missing + backup directory exists but past file is gone -> false and dir removed', async () => {
        await ctx.storage.setItem('k1', doc('k1', {n: 1}));
        await ctx.storage.setItem('k1', doc('k1', {n: 2}));
        removePath(baseFile(ctx, 'k1'));
        removePath(pastFile(ctx, 'k1')); // dir stays, file goes

        const res = await existsK1();
        expect(res.doesExist).toBe(false);
        expect(fileExists(path.join(ctx.statesPath, 'k1'))).toBe(false);
    });

    test('parsable base -> true regardless of any backup state', async () => {
        await ctx.storage.setItem('k1', doc('k1', {n: 1}));
        const res = await existsK1();
        expect(res.doesExist).toBe(true);
        expect(res.key).toBe('k1');
        expect(res.index).toBeNull();
    });

    test('unparsable base -> false without touching the backup', async () => {
        await ctx.storage.setItem('k1', doc('k1', {n: 1}));
        await ctx.storage.setItem('k1', doc('k1', {n: 2}));
        corruptFile(baseFile(ctx, 'k1'));

        const res = await existsK1();
        expect(res.doesExist).toBe(false);
        // unlike getItem, exists does not recover from the backup
        expect(readJsonFile(pastFile(ctx, 'k1'))).toEqual(doc('k1', {n: 1}));
    });
});
