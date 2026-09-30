import {setupStorage, teardownStorage, doc, ITestContext} from '../helpers';

/**
 * Concurrency: readers racing writers on overlapping keys. With atomic writes
 * plus the per-key queue, a reader must never see a partial/unparsable file,
 * never throw, and only ever observe an older or the newest complete document.
 */
describe('concurrency: mixed reads and writes', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage();
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('readers only ever observe complete documents', async () => {
        const keys = Array.from({length: 8}, (_, i) => `k${i}`);
        for (const k of keys) {
            await ctx.storage.setItem(k, doc(k, {round: 0}));
        }

        const rounds = 25;
        const writers = keys.map((k) =>
            (async () => {
                for (let r = 1; r <= rounds; r++) {
                    await ctx.storage.setItem(k, doc(k, {round: r}));
                }
            })(),
        );
        const readers = keys.map((k) =>
            (async () => {
                for (let i = 0; i < rounds; i++) {
                    const value = await ctx.storage.getItem(k);
                    expect(value._id).toBe(k);
                    expect(Number.isInteger(value.round)).toBe(true);
                    expect(value.round).toBeGreaterThanOrEqual(0);
                    expect(value.round).toBeLessThanOrEqual(rounds);
                }
            })(),
        );
        await Promise.all([...writers, ...readers]);

        for (const k of keys) {
            const value = await ctx.storage.getItem(k);
            expect(value.round).toBe(rounds);
        }
    });

    test('reads racing a first-ever write resolve undefined or the document, never garbage', async () => {
        const keys = Array.from({length: 20}, (_, i) => `fresh${i}`);
        const ops = keys.flatMap((k) => [
            ctx.storage.setItem(k, doc(k, {v: 1})),
            ctx.storage.getItem(k).then((value: any) => {
                if (value !== undefined) {
                    expect(value._id).toBe(k);
                }
            }),
        ]);
        await Promise.all(ops);
        const stored = await ctx.storage.keys();
        expect(stored.length).toBe(20);
    });

    test('writes racing deletes: surviving keys remain readable', async () => {
        const keys = Array.from({length: 10}, (_, i) => `k${i}`);
        for (const k of keys) {
            await ctx.storage.setItem(k, doc(k, {gen: 0}));
        }
        const doomed = keys.slice(0, 5);
        const kept = keys.slice(5);
        await Promise.all([
            ...doomed.map((k) => ctx.storage.removeItem(k)),
            ...doomed.map((k) => ctx.storage.setItem(k, doc(k, {gen: 1}))),
            ...kept.map((k) => ctx.storage.setItem(k, doc(k, {gen: 1}))),
        ]);
        // whether a doomed key survived depends on op order, but the queue
        // guarantees the on-disk state matches one of the two outcomes cleanly
        for (const k of kept) {
            const value = await ctx.storage.getItem(k);
            expect(value.gen).toBe(1);
        }
        const stored = await ctx.storage.keys();
        expect(stored.length).toBeGreaterThanOrEqual(kept.length);
    });
});
