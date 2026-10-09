import type {TDurability} from '../types';

/**
 * A parsed stored value: the raw JSON string as it lives in the log (needed
 * for index-payload checks) and its parsed form.
 */
export interface IEngineValue {
    raw: string;
    value: any;
}

/** Engine tuning — the Engine factory fills in every default. */
export interface IEngineOptions {
    durability: TDurability;
    /** Roll the active segment once it reaches this size. */
    segMaxBytes?: number;
    /** Generations kept per key: 1 keeps one previous generation, 0 current only. */
    history?: 0 | 1;
    /** Compact when deadBytes/totalBytes reaches this ratio. */
    compactDeadRatio?: number;
    /** Minimum dead bytes before the ratio rule fires. */
    compactMinDeadBytes?: number;
}

/**
 * The storage contract between the driver and whatever engine backs a
 * collection. `StorageDriver` depends only on this interface — a new engine
 * is a new implementation behind `createEngine`, with no driver changes.
 *
 * All mutations are expected to be safe to call from the driver's per-key
 * operation queue; `getEntry`/`dropKey` are the repair primitives the queue
 * serializes.
 */
export interface IEngine {
    /** Append the next generation of `key` (raw JSON string). */
    setItem(key: string, raw: string): Promise<void>;
    /** Read the current generation, repairing from the previous one when damaged. */
    getEntry(key: string): Promise<IEngineValue | undefined>;
    /** Tombstone a key so it stays deleted across restarts, then forget it. */
    dropKey(key: string): Promise<void>;
    /** Raw in-memory existence probe — zero IO. */
    has(key: string): boolean;
    /** Every live key (insertion order). */
    keys(): string[];
    /** Scan live keys, feeding (value, key) to the callback; truthy breaks. */
    iterate(callback: (value: any, key: string) => any, repair: (key: string) => Promise<IEngineValue | undefined>): Promise<void>;
    /** Drop every key the caller does not know (each through `drop`). */
    collectionSanitize(keep: string[], drop: (key: string) => Promise<void>): Promise<null>;
    /** Wipe the collection and rebuild an empty state. */
    clear(): Promise<void>;
}
