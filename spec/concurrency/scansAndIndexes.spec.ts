import {setupStorage, teardownStorage, indexBaseFile, doc, ITestContext} from '../helpers';

/**
 * Concurrency: keys()/iterate() running while writes land. The scans use a
 * bounded worker pool and defer per-key recovery work to the key queue, so
 * they must complete without corrupting or losing the in-flight documents.
 */
describe('concurrency: scans racing writes', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage();
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('keys() during a write storm reports a consistent superset', async () => {
        const total = 120;
        const insertAll = Promise.all(Array.from({length: total}, (_, i) =>
            ctx.storage.setItem(`k${i}`, doc(`k${i}`)),
        ));
        const scans = Array.from({length: 10}, () =>
            ctx.storage.keys().then((keys: string[]) => {
                for (const k of keys) {
                    expect(k).toMatch(/^k\d+$/);
                }
            }),
        );
        await Promise.all([insertAll, ...scans]);
        const final = await ctx.storage.keys();
        expect(final.length).toBe(total);
    });

    test('iterate() during a write storm yields only complete documents', async () => {
        const total = 80;
        for (let i = 0; i < total; i++) {
            await ctx.storage.setItem(`k${i}`, doc(`k${i}`));
        }
        const updates = Promise.all(Array.from({length: total}, (_, i) =>
            ctx.storage.setItem(`k${i}`, doc(`k${i}`, {round: 2})),
        ));
        const seen: string[] = [];
        const scan = ctx.storage.iterate((value: any, key: string) => {
            expect(value._id).toBe(key);
            seen.push(key);
        });
        await Promise.all([updates, scan]);
        expect(seen.length).toBe(total);
    });
});

/**
 * Concurrency: index persistence races. storeIndex rewrites the whole index
 * file; the queue serializes writes and readers must never see torn JSON.
 */
describe('concurrency: index writes racing fetches', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage();
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('parallel store/fetch never yields a corrupt index', async () => {
        const payload = (n: number) => JSON.stringify([{key: 'a', value: Array.from({length: n}, (_, i) => `id${i}`)}]);
        await ctx.storage.storeIndex('field', payload(1));

        const writers = Array.from({length: 30}, (_, i) =>
            ctx.storage.storeIndex('field', payload(i + 2)),
        );
        const readers = Array.from({length: 30}, () =>
            ctx.storage.fetchIndex('field').then((index: any) => {
                if (index !== undefined) {
                    expect(Array.isArray(index)).toBe(true);
                    expect(index[0].key).toBe('a');
                }
            }),
        );
        await Promise.all([...writers, ...readers]);

        const final = await ctx.storage.fetchIndex('field');
        expect(final[0].value.length).toBe(31);
        // base index file is valid JSON
        const raw = require('fs').readFileSync(indexBaseFile(ctx, 'field'), 'utf8');
        expect(() => JSON.parse(raw)).not.toThrow();
    });
});
