import {ElectronStorage} from '../../src';
import {
    setupStorage, teardownStorage, baseFile, pastFile, readJsonFile, fileExists, doc, ITestContext,
} from '../helpers';

describe('StorageDriver.setItem', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage();
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('first write persists only the base file (backup comes with the first update)', async () => {
        const value = doc('k1', {name: 'alice'});
        const resolved = await ctx.storage.setItem('k1', value);
        expect(resolved).toEqual(value);
        expect(readJsonFile(baseFile(ctx, 'k1'))).toEqual(value);
        expect(fileExists(pastFile(ctx, 'k1'))).toBe(false);
        expect(ctx.storage.allKeys).toContain('k1');
    });

    test('overwrite moves the previous document into the backup', async () => {
        const v1 = doc('k1', {name: 'alice'});
        const v2 = doc('k1', {name: 'bob'});
        await ctx.storage.setItem('k1', v1);
        await ctx.storage.setItem('k1', v2);
        expect(readJsonFile(baseFile(ctx, 'k1'))).toEqual(v2);
        expect(readJsonFile(pastFile(ctx, 'k1'))).toEqual(v1);
    });

    test('getItem round-trips a stored document', async () => {
        const value = doc('k1', {name: 'alice', nested: {a: [1, 2, 3]}});
        await ctx.storage.setItem('k1', value);
        await expect(ctx.storage.getItem('k1')).resolves.toEqual(value);
    });

    test('leaves no temp files behind', async () => {
        const {readdirSync} = require('fs');
        await ctx.storage.setItem('k1', doc('k1'));
        await ctx.storage.setItem('k1', doc('k1', {n: 2}));
        const strays = readdirSync(ctx.collectionPath).filter((f: string) => f.includes('.tmp'));
        expect(strays).toEqual([]);
    });

    test('rejects circular values instead of writing garbage', async () => {
        const circular: any = {};
        circular.self = circular;
        await expect(ctx.storage.setItem('k1', circular)).rejects.toBeTruthy();
        expect(fileExists(baseFile(ctx, 'k1'))).toBe(false);
    });

    test('constructor bootstraps the collection directory skeleton', () => {
        expect(ctx.storage.collectionPath).toContain('testcol');
        expect(ctx.storage.version).toBe('`v0.0.1');
        expect(fileExists(ctx.statesPath)).toBe(true);
        expect(new ElectronStorage('testdb', 'testcol', ctx.rootDir) instanceof ElectronStorage).toBe(true);
    });
});
