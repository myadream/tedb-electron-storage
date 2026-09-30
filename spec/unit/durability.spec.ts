import {readdirSync} from 'fs';
import {setupStorage, teardownStorage, baseFile, pastFile, readRaw, doc, ITestContext} from '../helpers';

const noTempLeft = (ctx: ITestContext): string[] =>
    readdirSync(ctx.collectionPath).filter((f) => f.includes('.tmp'));

describe('durability option', () => {
    let ctx: ITestContext;
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('defaults to strict', () => {
        ctx = setupStorage('durdb', 'durcol');
        expect(ctx.storage.durability).toBe('strict');
    });

    test('relaxed writes round-trip correctly (insert + update + index)', async () => {
        ctx = setupStorage('durdb', 'durcol', {durability: 'relaxed'});
        expect(ctx.storage.durability).toBe('relaxed');

        await ctx.storage.setItem('k1', doc('k1', {v: 1}));
        await ctx.storage.setItem('k2', doc('k2', {v: 1}));
        // update path: past holds previous generation, base holds the new one
        await ctx.storage.setItem('k1', doc('k1', {v: 2}));

        expect(readRaw(baseFile(ctx, 'k1'))).toBe(JSON.stringify(doc('k1', {v: 2})));
        expect(readRaw(pastFile(ctx, 'k1'))).toBe(JSON.stringify(doc('k1', {v: 1})));
        expect(await ctx.storage.getItem('k1')).toEqual(doc('k1', {v: 2}));
        expect(await ctx.storage.getItem('k2')).toEqual(doc('k2', {v: 1}));
        expect(await ctx.storage.keys()).toEqual(['k1', 'k2']);
        // atomic rename still applies — no temp files survive
        expect(noTempLeft(ctx)).toEqual([]);

        await ctx.storage.storeIndex('words', JSON.stringify([{key: 'k1', value: ['k1']}]));
        const fetched = await ctx.storage.fetchIndex('words');
        expect(fetched).toEqual([{key: 'k1', value: ['k1']}]);
        expect(noTempLeft(ctx)).toEqual([]);

        await ctx.storage.removeItem('k1');
        expect(await ctx.storage.getItem('k1')).toBeUndefined();
    });
});
