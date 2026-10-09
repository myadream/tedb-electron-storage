import {GroupSync, RELAXED_FALLBACK_MS, SYNC_MAX_BYTES, SYNC_MAX_OPS} from '../../../src/LogEngine/sync';

type FileHandle = import('fs/promises').FileHandle;

const fakeHandle = (synces: number[]): FileHandle => {
    return {sync: async () => { synces.push(1); }} as unknown as FileHandle;
};

describe('log engine — GroupSync (group commit)', () => {
    test('coalesces concurrent waiters onto one sync', async () => {
        const synces: number[] = [];
        const gs = new GroupSync(() => fakeHandle(synces), 5);
        const a = gs.flush();
        const b = gs.flush();
        expect(a).toBe(b); // same promise — one sync for all waiters
        await Promise.all([a, b]);
        expect(synces).toHaveLength(1);
    });

    test('waits out the interval window before syncing', async () => {
        const synces: number[] = [];
        const gs = new GroupSync(() => fakeHandle(synces), 40);
        const start = Date.now();
        await gs.flush();
        expect(Date.now() - start).toBeGreaterThanOrEqual(30);
        expect(synces).toHaveLength(1);
    });

    test('short windows spin instead of inheriting the OS timer clamp', async () => {
        const synces: number[] = [];
        // a 2 ms window; setTimeout would clamp this to ~15.6 ms on Windows
        const gs = new GroupSync(() => fakeHandle(synces), 2);
        const start = Date.now();
        await gs.flush();
        const elapsed = Date.now() - start;
        expect(synces).toHaveLength(1);
        expect(elapsed).toBeGreaterThanOrEqual(1);
        expect(elapsed).toBeLessThan(12);
    });

    test('flushes immediately once the byte batch is full', async () => {
        const synces: number[] = [];
        const gs = new GroupSync(() => fakeHandle(synces), 10_000, SYNC_MAX_BYTES, SYNC_MAX_OPS);
        const start = Date.now();
        const pending = gs.mark(SYNC_MAX_BYTES);
        expect(pending).not.toBeNull();
        await pending;
        expect(Date.now() - start).toBeLessThan(9_000);
        expect(synces).toHaveLength(1);
    });

    test('flushes immediately once the op-count batch is full', async () => {
        const synces: number[] = [];
        const gs = new GroupSync(() => fakeHandle(synces), 10_000, SYNC_MAX_BYTES, SYNC_MAX_OPS);
        let pending = null;
        for (let i = 0; i < SYNC_MAX_OPS; i++) {
            pending = gs.mark(1);
        }
        expect(pending).not.toBeNull();
        await pending;
        expect(synces).toHaveLength(1);
    });

    test('small batches do not trigger an immediate flush', () => {
        const gs = new GroupSync(() => null, 10_000, SYNC_MAX_BYTES, SYNC_MAX_OPS);
        expect(gs.mark(10)).toBeNull();
    });

    test('resolves without a target handle (segment switched underneath)', async () => {
        const gs = new GroupSync(() => null, 1);
        await expect(gs.flush()).resolves.toBeUndefined();
    });

    test('relaxed fallback only fires once per interval', async () => {
        const synces: number[] = [];
        const gs = new GroupSync(() => fakeHandle(synces), 1);
        expect(gs.maybeFallback()).toBeNull(); // synced just now (constructor)
        (gs as unknown as {lastSyncAt: number}).lastSyncAt = Date.now() - RELAXED_FALLBACK_MS - 1;
        const pending = gs.maybeFallback();
        expect(pending).not.toBeNull();
        await pending;
        expect(synces).toHaveLength(1);
        expect(gs.maybeFallback()).toBeNull(); // reset by the sync
    });
});
