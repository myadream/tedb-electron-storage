import type {FileHandle} from 'fs/promises';

/** Sync fires at most this long after the first waiter arrives (group commit window). */
export const SYNC_INTERVAL_MS = 2;
/** Batch limits: a full batch flushes immediately instead of waiting out the window. */
export const SYNC_MAX_BYTES = 1024 * 1024;
export const SYNC_MAX_OPS = 256;
/** Relaxed durability still syncs at least once per this interval (bounded loss window). */
export const RELAXED_FALLBACK_MS = 1000;
/** Waits up to this long spin on setImmediate — Windows clamps setTimeout to ~15.6ms. */
const SPIN_MAX_MS = 4;

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitOut = (ms: number): Promise<void> => {
    if (ms <= 0) {
        return Promise.resolve();
    }
    if (ms > SPIN_MAX_MS) {
        return sleep(ms);
    }
    // short coalescing windows must not inherit the OS timer clamp
    const end = Date.now() + ms;
    return new Promise<void>((resolve) => {
        const tick = (): void => {
            if (Date.now() >= end) {
                resolve();
            } else {
                setImmediate(tick);
            }
        };
        tick();
    });
};

/**
 * Group commit for the log engine: concurrent writers share one fsync of the
 * active segment. All callers that arrive between two syncs await the same
 * promise; the sync runs after at most one interval, or immediately once a
 * batch limit is hit. A sync flushes every write appended before it starts,
 * so a writer whose append preceded flush() is always covered by it.
 */
export class GroupSync {
    private lastSyncAt = Date.now();
    private pending: Promise<void> | null = null;
    private bufferedBytes = 0;
    private bufferedOps = 0;

    constructor(
        private readonly target: () => FileHandle | null,
        private readonly intervalMs: number = SYNC_INTERVAL_MS,
        private readonly maxBytes: number = SYNC_MAX_BYTES,
        private readonly maxOps: number = SYNC_MAX_OPS,
    ) {}

    /** Record an appended write's cost; returns the flush to await when the batch is full. */
    mark(bytes: number): Promise<void> | null {
        this.bufferedBytes += bytes;
        this.bufferedOps += 1;
        if (this.bufferedBytes >= this.maxBytes || this.bufferedOps >= this.maxOps) {
            return this.flush(true);
        }
        return null;
    }

    /**
     * Coalesced sync — every caller until it completes shares this promise.
     * The sync runs once the interval since the previous sync has elapsed
     * (the coalescing window), or immediately when `immediate` is set (full
     * batch) or the window has already passed.
     */
    flush(immediate: boolean = false): Promise<void> {
        if (this.pending) {
            return this.pending;
        }
        const elapsed = Date.now() - this.lastSyncAt;
        const wait = immediate || elapsed >= this.intervalMs ? 0 : this.intervalMs - elapsed;
        this.pending = waitOut(wait).then(async () => {
            const fh = this.target();
            try {
                if (fh) {
                    await fh.sync();
                }
            } finally {
                this.lastSyncAt = Date.now();
                this.bufferedBytes = 0;
                this.bufferedOps = 0;
                this.pending = null;
            }
        });
        return this.pending;
    }

    /** Relaxed-mode fallback: sync at most once per the fallback interval. */
    maybeFallback(): Promise<void> | null {
        if (Date.now() - this.lastSyncAt >= RELAXED_FALLBACK_MS) {
            return this.flush();
        }
        return null;
    }
}
