import {
    setupStorage, teardownStorage, baseFile, pastFile, readJsonFile, fileExists,
    corruptFile, doc, ITestContext,
} from '../helpers';

describe('StorageDriver.getItem', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage();
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('resolves undefined for a missing key', async () => {
        await expect(ctx.storage.getItem('nope')).resolves.toBeUndefined();
    });

    test('recovers from a corrupted base file using the backup', async () => {
        const v1 = doc('k1', {name: 'alice'});
        const v2 = doc('k1', {name: 'bob'});
        await ctx.storage.setItem('k1', v1);
        await ctx.storage.setItem('k1', v2);
        corruptFile(baseFile(ctx, 'k1'));

        await expect(ctx.storage.getItem('k1')).resolves.toEqual(v1);
        // base was restored from the backup
        expect(readJsonFile(baseFile(ctx, 'k1'))).toEqual(v1);
    });

    test('drops the key when base and backup are both corrupted', async () => {
        const v1 = doc('k1', {name: 'alice'});
        const v2 = doc('k1', {name: 'bob'});
        await ctx.storage.setItem('k1', v1);
        await ctx.storage.setItem('k1', v2);
        corruptFile(baseFile(ctx, 'k1'));
        corruptFile(pastFile(ctx, 'k1'));

        await expect(ctx.storage.getItem('k1')).resolves.toBeFalsy();
        expect(fileExists(baseFile(ctx, 'k1'))).toBe(false);
        expect(fileExists(pastFile(ctx, 'k1'))).toBe(false);
        expect(ctx.storage.allKeys).not.toContain('k1');
    });

    test('recovers when the base file is missing but the backup survives', async () => {
        const v1 = doc('k1', {name: 'alice'});
        const v2 = doc('k1', {name: 'bob'});
        await ctx.storage.setItem('k1', v1);
        await ctx.storage.setItem('k1', v2);
        const {unlinkSync} = require('fs');
        unlinkSync(baseFile(ctx, 'k1'));

        await expect(ctx.storage.getItem('k1')).resolves.toEqual(v1);
        expect(readJsonFile(baseFile(ctx, 'k1'))).toEqual(v1);
    });

    test('drops the key when base is missing and no backup directory exists', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        const {unlinkSync, rmSync} = require('fs');
        unlinkSync(baseFile(ctx, 'k1'));
        rmSync(ctx.statesPath, {recursive: true});

        await expect(ctx.storage.getItem('k1')).resolves.toBeUndefined();
        expect(ctx.storage.allKeys).not.toContain('k1');
    });
});
