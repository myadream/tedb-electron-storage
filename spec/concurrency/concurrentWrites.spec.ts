import {
    setupStorage, teardownStorage, baseFile, pastFile, readJsonFile, doc, ITestContext,
} from '../helpers';

/**
 * Concurrency: many writers racing on the SAME key. Before the per-key queue
 * existed, the copy-to-backup and truncate-write steps interleaved, so the
 * "backup holds the previous version" invariant could break and readers could
 * observe partial writes.
 */
describe('concurrency: same-key writes', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage();
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('every writer resolves and the final file holds exactly one valid document', async () => {
        const writers = Array.from({length: 50}, (_, i) =>
            ctx.storage.setItem('hot', doc('hot', {writer: i})),
        );
        const results = await Promise.all(writers);
        expect(results).toHaveLength(50);

        const finalDoc = readJsonFile(baseFile(ctx, 'hot'));
        expect(finalDoc._id).toBe('hot');
        expect(finalDoc.writer).toBeGreaterThanOrEqual(0);
        expect(finalDoc.writer).toBeLessThan(50);

        // the backup must also be a valid document of the same shape — the
        // previous generation, not a torn write
        const pastDoc = readJsonFile(pastFile(ctx, 'hot'));
        expect(pastDoc._id).toBe('hot');
        expect(pastDoc.writer).not.toBe(finalDoc.writer);
    });

    test('getItem after the storm returns a coherent document', async () => {
        await Promise.all(Array.from({length: 30}, (_, i) =>
            ctx.storage.setItem('hot', doc('hot', {writer: i})),
        ));
        const value = await ctx.storage.getItem('hot');
        expect(value._id).toBe('hot');
        expect(typeof value.writer).toBe('number');
    });

    test('allKeys stays consistent (no duplicate entries)', async () => {
        await Promise.all(Array.from({length: 30}, (_, i) =>
            ctx.storage.setItem('hot', doc('hot', {writer: i})),
        ));
        expect(ctx.storage.allKeys.filter((k) => k === 'hot')).toHaveLength(1);
    });
});

/**
 * Concurrency: independent keys written in parallel — throughput stays high
 * and no key is lost (this is the bulk-insert scenario).
 */
describe('concurrency: parallel writes across keys', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage();
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('100 keys x 5 updates each all survive', async () => {
        const keys = Array.from({length: 100}, (_, i) => `k${i}`);
        await Promise.all(keys.map((k) => ctx.storage.setItem(k, doc(k, {round: 0}))));
        await Promise.all(keys.map((k) =>
            Promise.all(Array.from({length: 5}, (_, r) =>
                ctx.storage.setItem(k, doc(k, {round: r + 1})),
            )),
        ));
        const stored = await ctx.storage.keys();
        expect(stored.length).toBe(100);
        for (const k of keys) {
            const value = await ctx.storage.getItem(k);
            expect(value._id).toBe(k);
            expect(value.round).toBeGreaterThanOrEqual(1);
        }
    });
});
