import {
    setupStorage, teardownStorage, baseFile, pastFile, fileExists, doc, ITestContext,
} from '../helpers';

describe('StorageDriver.removeItem', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage();
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('removes base file, backup and the cached key', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        await ctx.storage.setItem('k1', doc('k1', {n: 2}));
        await ctx.storage.removeItem('k1');

        expect(fileExists(baseFile(ctx, 'k1'))).toBe(false);
        expect(fileExists(pastFile(ctx, 'k1'))).toBe(false);
        expect(ctx.storage.allKeys).not.toContain('k1');
        await expect(ctx.storage.getItem('k1')).resolves.toBeUndefined();
    });

    test('resolves when the key does not exist', async () => {
        await expect(ctx.storage.removeItem('nope')).resolves.toBeFalsy();
    });

    test('re-inserting after removal works', async () => {
        const v1 = doc('k1', {round: 1});
        await ctx.storage.setItem('k1', v1);
        await ctx.storage.removeItem('k1');
        const v2 = doc('k1', {round: 2});
        await ctx.storage.setItem('k1', v2);
        await expect(ctx.storage.getItem('k1')).resolves.toEqual(v2);
        // removeItem wiped the backup dir; the lazy re-insert writes base only
        expect(fileExists(baseFile(ctx, 'k1'))).toBe(true);
        expect(fileExists(pastFile(ctx, 'k1'))).toBe(false);
    });
});
