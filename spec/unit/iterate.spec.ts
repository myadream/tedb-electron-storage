import {
    setupStorage, teardownStorage, corruptFile, baseFile, pastFile, doc, ITestContext,
} from '../helpers';

describe('StorageDriver.iterate', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage();
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('iterates every document with (value, key) callback order', async () => {
        await ctx.storage.setItem('k1', doc('k1', {n: 1}));
        await ctx.storage.setItem('k2', doc('k2', {n: 2}));
        const seen: Array<[string, string]> = [];
        await ctx.storage.iterate((value: any, key: string) => {
            seen.push([value._id, key]);
        });
        expect(seen.length).toBe(2);
        for (const [valueId, key] of seen) {
            expect(valueId).toBe(key);
        }
        expect(seen.map((s) => s[1]).sort()).toEqual(['k1', 'k2']);
    });

    test('recovers a corrupted base from backup during iteration', async () => {
        await ctx.storage.setItem('k1', doc('k1', {n: 1}));
        await ctx.storage.setItem('k1', doc('k1', {n: 2}));
        corruptFile(baseFile(ctx, 'k1'));
        let seen = 0;
        await ctx.storage.iterate(() => {
            seen++;
        });
        expect(seen).toBe(1);
    });

    test('a truthy callback return stops iteration early', async () => {
        const total = 200;
        for (let i = 0; i < total; i++) {
            await ctx.storage.setItem(`k${i}`, doc(`k${i}`));
        }
        let calls = 0;
        await ctx.storage.iterate(() => {
            calls++;
            return true; // break on the first document
        });
        expect(calls).toBeGreaterThanOrEqual(1);
        expect(calls).toBeLessThan(total);
    });

    test('propagates callback exceptions', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        await expect(ctx.storage.iterate(() => {
            throw new Error('boom');
        })).rejects.toThrow('boom');
    });

    test('resolves when the collection directory is missing', async () => {
        const {rmSync} = require('fs');
        rmSync(ctx.collectionPath, {recursive: true});
        let seen = 0;
        await expect(ctx.storage.iterate(() => {
            seen++;
        })).resolves.toBeUndefined();
        expect(seen).toBe(0);
    });

    test('iterates a doc whose backup is corrupted too (purged, no callback)', async () => {
        await ctx.storage.setItem('k1', doc('k1', {n: 1}));
        await ctx.storage.setItem('k1', doc('k1', {n: 2}));
        await ctx.storage.setItem('k2', doc('k2'));
        corruptFile(baseFile(ctx, 'k1'));
        corruptFile(pastFile(ctx, 'k1'));
        const seen: string[] = [];
        await ctx.storage.iterate((_value: any, key: string) => {
            seen.push(key);
        });
        expect(seen).toEqual(['k2']);
    });
});
