import {ElectronStorage} from '../../src';
import {
    setupStorage, teardownStorage, baseFile, pastFile, readJsonFile, fileExists,
    corruptFile, writeRaw, doc, ITestContext,
} from '../helpers';

describe('StorageDriver.keys', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage();
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('returns an empty list for a fresh collection', async () => {
        await expect(ctx.storage.keys()).resolves.toEqual([]);
    });

    test('returns every inserted key', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        await ctx.storage.setItem('k2', doc('k2'));
        await ctx.storage.setItem('k3', doc('k3'));
        const keys = await ctx.storage.keys();
        expect(keys.sort()).toEqual(['k1', 'k2', 'k3']);
    });

    test('a fresh instance rediscovers keys from disk', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        await ctx.storage.setItem('k2', doc('k2'));
        const fresh = new ElectronStorage('testdb', 'testcol', ctx.rootDir);
        const keys = await fresh.keys();
        expect(keys.sort()).toEqual(['k1', 'k2']);
    });

    test('ignores atomic-write temp files left behind by a crash', async () => {
        await ctx.storage.setItem('k1', doc('k1'));
        // simulate a crashed atomic write: a leftover temp file next to the data
        writeRaw(`${baseFile(ctx, 'k1')}.tmp.9999.7`, JSON.stringify(doc('k1')));
        const keys = await ctx.storage.keys();
        expect(keys.filter((k) => k.includes('tmp'))).toEqual([]);
        expect(keys).toContain('k1');
    });

    test('recovers a corrupted base file while scanning (fresh instance)', async () => {
        await ctx.storage.setItem('k1', doc('k1', {n: 1}));
        await ctx.storage.setItem('k1', doc('k1', {n: 2}));
        corruptFile(baseFile(ctx, 'k1'));
        const fresh = new ElectronStorage('testdb', 'testcol', ctx.rootDir);
        const keys = await fresh.keys();
        expect(keys).toContain('k1');
        expect(readJsonFile(baseFile(ctx, 'k1'))).toEqual(doc('k1', {n: 1}));
        expect(fileExists(pastFile(ctx, 'k1'))).toBe(true);
    });

    test('purges a key whose base and backup are both corrupted (fresh instance)', async () => {
        await ctx.storage.setItem('k1', doc('k1', {n: 1}));
        await ctx.storage.setItem('k1', doc('k1', {n: 2}));
        corruptFile(baseFile(ctx, 'k1'));
        corruptFile(pastFile(ctx, 'k1'));
        const fresh = new ElectronStorage('testdb', 'testcol', ctx.rootDir);
        const keys = await fresh.keys();
        expect(keys).not.toContain('k1');
        expect(fileExists(baseFile(ctx, 'k1'))).toBe(false);
        expect(fileExists(pastFile(ctx, 'k1'))).toBe(false);
    });

    test('detects external file deletion via set comparison, not just counts', async () => {
        // insert two keys, externally delete one and create another so the
        // total file COUNT stays the same — the old count-only heuristic
        // returned the stale cache in exactly this scenario
        await ctx.storage.setItem('k1', doc('k1'));
        await ctx.storage.setItem('k2', doc('k2'));
        const {unlinkSync} = require('fs');
        unlinkSync(baseFile(ctx, 'k1'));
        await new Promise((res) => setTimeout(res, 20));
        writeRaw(baseFile(ctx, 'k9'), JSON.stringify(doc('k9')));
        const fresh = new ElectronStorage('testdb', 'testcol', ctx.rootDir);
        const keys = await fresh.keys();
        expect(keys).toContain('k9');
        expect(keys).toContain('k2');
    });
});
