import {
    setupStorage, teardownStorage, corruptFile, baseFile, doc, ITestContext,
} from '../helpers';

describe('StorageDriver.exists / collectionSanitize / clear', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage();
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    describe('exists', () => {
        test('reports true for a persisted key', async () => {
            await ctx.storage.setItem('k1', doc('k1'));
            const res = await ctx.storage.exists({key: 'k1', value: 'k1'}, null, 'name');
            expect(res.doesExist).toBe(true);
        });

        test('reports false for a missing key', async () => {
            const res = await ctx.storage.exists({key: 'nope', value: 'nope'}, null, 'name');
            expect(res.doesExist).toBe(false);
        });

        test('reports false when the base file is corrupted (no recovery here)', async () => {
            await ctx.storage.setItem('k1', doc('k1'));
            corruptFile(baseFile(ctx, 'k1'));
            const res = await ctx.storage.exists({key: 'k1', value: 'k1'}, null, 'name');
            expect(res.doesExist).toBe(false);
        });
    });

    describe('collectionSanitize', () => {
        test('removes stored keys that are absent from the given key list', async () => {
            await ctx.storage.setItem('k1', doc('k1'));
            await ctx.storage.setItem('k2', doc('k2'));
            await ctx.storage.setItem('k3', doc('k3'));
            await ctx.storage.collectionSanitize(['k1', 'k2']);
            const keys = await ctx.storage.keys();
            expect(keys.sort()).toEqual(['k1', 'k2']);
            const {existsSync} = require('fs');
            expect(existsSync(baseFile(ctx, 'k3'))).toBe(false);
        });

        test('is a no-op when everything matches', async () => {
            await ctx.storage.setItem('k1', doc('k1'));
            await ctx.storage.collectionSanitize(['k1']);
            await expect(ctx.storage.getItem('k1')).resolves.toEqual(doc('k1'));
        });

        test('handles a key whose backup directory is already gone', async () => {
            await ctx.storage.setItem('k1', doc('k1'));
            await ctx.storage.setItem('k2', doc('k2'));
            const {rmSync} = require('fs');
            rmSync(ctx.statesPath, {recursive: true});
            await expect(ctx.storage.collectionSanitize(['k1'])).resolves.toBeFalsy();
        });
    });

    describe('clear', () => {
        test('wipes the collection and keeps the instance usable', async () => {
            await ctx.storage.setItem('k1', doc('k1'));
            await ctx.storage.setItem('k2', doc('k2'));
            await ctx.storage.clear();
            expect(await ctx.storage.keys()).toEqual([]);
            expect(ctx.storage.allKeys).toEqual([]);
            // the skeleton is recreated, so writes keep working afterwards
            const v = doc('k3');
            await ctx.storage.setItem('k3', v);
            await expect(ctx.storage.getItem('k3')).resolves.toEqual(v);
        });
    });
});
