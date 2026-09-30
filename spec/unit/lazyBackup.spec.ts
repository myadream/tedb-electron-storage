import * as path from 'path';
import {
    setupStorage, teardownStorage, baseFile, pastFile, indexBaseFile, indexPastFile,
    readJsonFile, readRaw, fileExists, corruptFile, doc, EMPTY_INDEX, ITestContext,
} from '../helpers';

/**
 * Pins the lazyBackup option on both sides:
 * - default (on): a key's first write persists the base file only; the past
 *   copy appears with the first update. Recovery for a never-updated key
 *   falls back to the "no backup dir" branch (drop + untrack).
 * - explicit false: legacy behavior — the very first write already fills
 *   base + backup.
 */
describe('lazyBackup option', () => {
    let ctx: ITestContext;
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('defaults to on', () => {
        ctx = setupStorage();
        expect(ctx.storage.lazyBackup).toBe(true);
    });

    describe('default (on)', () => {
        beforeEach(() => {
            ctx = setupStorage();
        });

        test('first write persists base only, no backup dir is created', async () => {
            const v1 = doc('k1', {v: 1});
            await ctx.storage.setItem('k1', v1);
            expect(readJsonFile(baseFile(ctx, 'k1'))).toEqual(v1);
            expect(fileExists(pastFile(ctx, 'k1'))).toBe(false);
            expect(fileExists(path.dirname(pastFile(ctx, 'k1')))).toBe(false);
        });

        test('first update creates the backup with the previous generation', async () => {
            const v1 = doc('k1', {v: 1});
            const v2 = doc('k1', {v: 2});
            await ctx.storage.setItem('k1', v1);
            await ctx.storage.setItem('k1', v2);
            expect(readJsonFile(baseFile(ctx, 'k1'))).toEqual(v2);
            expect(readJsonFile(pastFile(ctx, 'k1'))).toEqual(v1);
        });

        test('a never-updated key still recovers via the no-backup branch (drop + untrack)', async () => {
            await ctx.storage.setItem('k1', doc('k1', {v: 1}));
            corruptFile(baseFile(ctx, 'k1')); // no backup dir exists for this key

            await expect(ctx.storage.getItem('k1')).resolves.toBeUndefined();
            expect(fileExists(baseFile(ctx, 'k1'))).toBe(false);
            expect(ctx.storage.allKeys).not.toContain('k1');
        });

        test('first index store persists base only; update creates the backup', async () => {
            const p1 = JSON.stringify([{key: 'a', value: ['id1']}]);
            const p2 = JSON.stringify([{key: 'a', value: ['id1', 'id2']}]);
            await ctx.storage.storeIndex('name', p1);
            expect(fileExists(indexBaseFile(ctx, 'name'))).toBe(true);
            expect(fileExists(indexPastFile(ctx, 'name'))).toBe(false);

            await ctx.storage.storeIndex('name', p2);
            expect(readJsonFile(indexBaseFile(ctx, 'name'))).toEqual([{key: 'a', value: ['id1', 'id2']}]);
            expect(readJsonFile(indexPastFile(ctx, 'name'))).toEqual([{key: 'a', value: ['id1']}]);
        });
    });

    describe('lazyBackup: false (legacy)', () => {
        beforeEach(() => {
            ctx = setupStorage('testdb', 'testcol', {lazyBackup: false});
        });

        test('first write fills base and backup with the same payload', async () => {
            const v1 = doc('k1', {v: 1});
            await ctx.storage.setItem('k1', v1);
            expect(readJsonFile(baseFile(ctx, 'k1'))).toEqual(v1);
            expect(readJsonFile(pastFile(ctx, 'k1'))).toEqual(v1);
        });

        test('first non-empty index store fills base and backup', async () => {
            const p1 = JSON.stringify([{key: 'a', value: ['id1']}]);
            await ctx.storage.storeIndex('name', p1);
            expect(readJsonFile(indexBaseFile(ctx, 'name'))).toEqual([{key: 'a', value: ['id1']}]);
            expect(readJsonFile(indexPastFile(ctx, 'name'))).toEqual([{key: 'a', value: ['id1']}]);
        });

        test('empty-index first store keeps the placeholder-only shape', async () => {
            await ctx.storage.storeIndex('name', EMPTY_INDEX);
            expect(fileExists(indexBaseFile(ctx, 'name'))).toBe(false);
            expect(readRaw(indexPastFile(ctx, 'name'))).toBe(EMPTY_INDEX);
        });
    });
});
