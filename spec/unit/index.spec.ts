import {indexCheck} from '../../src/StorageDriver/StoreIndex';
import {
    setupStorage, teardownStorage, indexBaseFile, indexPastFile, readJsonFile,
    fileExists, corruptFile, ITestContext,
} from '../helpers';

describe('StorageDriver index persistence', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage();
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('storeIndex persists the index to the base file (backup on update)', async () => {
        const payload = JSON.stringify([{key: 'a', value: ['id1', 'id2']}]);
        await ctx.storage.storeIndex('name', payload);
        expect(readJsonFile(indexBaseFile(ctx, 'name'))).toEqual([{key: 'a', value: ['id1', 'id2']}]);
        expect(fileExists(indexPastFile(ctx, 'name'))).toBe(false);
    });

    test('fetchIndex returns the parsed index', async () => {
        const payload = JSON.stringify([{key: 'a', value: ['id1']}]);
        await ctx.storage.storeIndex('name', payload);
        await expect(ctx.storage.fetchIndex('name')).resolves.toEqual([{key: 'a', value: ['id1']}]);
    });

    test('a later storeIndex moves the previous payload into the backup', async () => {
        const p1 = JSON.stringify([{key: 'a', value: ['id1']}]);
        const p2 = JSON.stringify([{key: 'a', value: ['id1', 'id2']}]);
        await ctx.storage.storeIndex('name', p1);
        await ctx.storage.storeIndex('name', p2);
        expect(readJsonFile(indexBaseFile(ctx, 'name'))).toEqual([{key: 'a', value: ['id1', 'id2']}]);
        expect(readJsonFile(indexPastFile(ctx, 'name'))).toEqual([{key: 'a', value: ['id1']}]);
    });

    test('an empty index removes the base file and keeps only the backup', async () => {
        await ctx.storage.storeIndex('name', JSON.stringify([{key: 'a', value: ['id1']}]));
        await ctx.storage.storeIndex('name', JSON.stringify([{key: null, value: []}]));
        expect(fileExists(indexBaseFile(ctx, 'name'))).toBe(false);
        expect(fileExists(indexPastFile(ctx, 'name'))).toBe(true);
        await expect(ctx.storage.fetchIndex('name')).resolves.toBeFalsy();
    });

    test('removeIndex deletes base and backup', async () => {
        await ctx.storage.storeIndex('name', JSON.stringify([{key: 'a', value: ['id1']}]));
        await ctx.storage.removeIndex('name');
        expect(fileExists(indexBaseFile(ctx, 'name'))).toBe(false);
        expect(fileExists(indexPastFile(ctx, 'name'))).toBe(false);
        await expect(ctx.storage.removeIndex('missing')).resolves.toBeFalsy();
    });

    test('recovers a corrupted index base from its backup', async () => {
        const p1 = JSON.stringify([{key: 'a', value: ['id1']}]);
        const p2 = JSON.stringify([{key: 'a', value: ['id1', 'id2']}]);
        await ctx.storage.storeIndex('name', p1);
        await ctx.storage.storeIndex('name', p2);
        corruptFile(indexBaseFile(ctx, 'name'));
        await expect(ctx.storage.fetchIndex('name')).resolves.toEqual([{key: 'a', value: ['id1']}]);
        expect(readJsonFile(indexBaseFile(ctx, 'name'))).toEqual([{key: 'a', value: ['id1']}]);
    });

    describe('indexCheck', () => {
        test('recognizes the empty-index placeholders', () => {
            expect(indexCheck('[{"key":null,"value":[]}]')).toBe(true);
            expect(indexCheck('[{"key":null,"value":[null]}]')).toBe(true);
            expect(indexCheck('[{"key":null, "value":[]}]')).toBe(true);
            expect(indexCheck('[{"key": null, "value": []}]')).toBe(true);
        });

        test('rejects non-empty and malformed indexes', () => {
            expect(indexCheck('[{"key":"a","value":["x"]}]')).toBe(false);
            expect(indexCheck('[{"key":null,"value":["x"]}]')).toBe(false);
            expect(indexCheck('[]')).toBe(false);
            expect(indexCheck('not json')).toBe(false);
            expect(indexCheck('[{"key":null,"value":[]},{"key":"a","value":[]}]')).toBe(false);
        });
    });
});
