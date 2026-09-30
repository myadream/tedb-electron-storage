import {unlinkSync, rmSync} from 'fs';
import * as path from 'path';
import {setupStorage, teardownStorage, baseFile, pastFile, doc, ITestContext} from '../helpers';

describe('allKeys Set mirror', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage('keysetdb', 'keysetcol');
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('repeated writes of one key stay deduplicated in both structures', async () => {
        for (let i = 0; i < 5; i++) {
            await ctx.storage.setItem('k1', doc('k1', {v: i}));
        }
        expect(ctx.storage.allKeys).toEqual(['k1']);
        expect([...ctx.storage.allKeysSet]).toEqual(['k1']);
    });

    test('removeItem drops the key from array and set; re-adding does not duplicate', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        await ctx.storage.setItem('k2', doc('k2'));
        await ctx.storage.removeItem('k1');
        expect(ctx.storage.allKeys).toEqual(['k2']);
        expect(ctx.storage.allKeysSet.has('k1')).toBe(false);
        expect(ctx.storage.allKeysSet.has('k2')).toBe(true);

        await ctx.storage.setItem('k1', doc('k1'));
        expect(ctx.storage.allKeys).toEqual(['k2', 'k1']);
        expect(ctx.storage.allKeysSet.size).toBe(2);
    });

    test('getItem untracks keys whose files vanished externally', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        await ctx.storage.setItem('k2', doc('k2'));
        // externally delete every trace of k1 (base + backup dir)
        unlinkSync(baseFile(ctx, 'k1'));
        rmSync(path.dirname(pastFile(ctx, 'k1')), {recursive: true, force: true});

        expect(await ctx.storage.getItem('k1')).toBeUndefined();
        expect(ctx.storage.allKeys).toEqual(['k2']);
        expect(ctx.storage.allKeysSet.has('k1')).toBe(false);
    });

    test('collectionSanitize untracks removed keys', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        await ctx.storage.setItem('k2', doc('k2'));
        await ctx.storage.collectionSanitize(['k2']);
        expect(ctx.storage.allKeys).toEqual(['k2']);
        expect(ctx.storage.allKeysSet.has('k1')).toBe(false);
    });

    test('clear resets both structures', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        await ctx.storage.clear();
        expect(ctx.storage.allKeys).toEqual([]);
        expect(ctx.storage.allKeysSet.size).toBe(0);
    });
});
