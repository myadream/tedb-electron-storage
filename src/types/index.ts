import {IStorageDriver, Isanitize, Iexist} from './StorageDriver_BaseInterface';
import {KeyedQueue} from '../utils/KeyedQueue';

export type {Isanitize, Iexist};
/**
 * tedb's Datastore consumes the callback as (value, key) — verified against
 * tedb@0.4.4 searchCollection. The old (key, value) declaration was inverted.
 */
export type TiteratorCB = (value: any, key: string, iteratorNumber?: number) => any;

/**
 * Crash-safety level for writes.
 * - 'strict' (default): fsync temp file + directory before rename — a
 *   confirmed write survives power loss.
 * - 'relaxed': skip both fsyncs but keep the atomic temp+rename, so files can
 *   never tear; a crash may lose the last OS-cache-window of writes (same
 *   promise as an unsynced regular file). Much faster on Windows.
 */
export type TDurability = 'strict' | 'relaxed';

/** Constructor options for ElectronStorage. */
export interface IElectronStorageOptions {
    durability?: TDurability;
    /**
     * First write of a key persists only the base file; the backup (past) is
     * created by the first update of that key. Default true — inserts cost one
     * atomic write instead of two. `false` restores the legacy behavior where
     * the very first write already fills base + backup. Atomicity (temp file +
     * rename) is unaffected either way.
     */
    lazyBackup?: boolean;
}

export interface IStorageDriverExtended extends IStorageDriver {
    collectionPath: string;
    allKeys: string[];
    /** Set mirror of allKeys — O(1) membership on the write hot path. */
    allKeysSet: Set<string>;
    version: string;
    durability: TDurability;
    /** See IElectronStorageOptions.lazyBackup. */
    lazyBackup: boolean;
    /**
     * Per-key operation queue serializing reads/writes/removals targeting the
     * same key. Collection-wide scans use it to run their per-key recovery
     * work without racing in-flight writes.
     */
    operationQueue: KeyedQueue;

    /** Record a key once it is persisted; no-op if already tracked. */
    trackKey(key: string): void;
    /** Drop a key after its files are gone; keeps allKeys and allKeysSet in sync. */
    untrackKey(key: string): void;

    getItem(key: string): Promise<any>;
    setItem(key: string, value: any): Promise<any>;
    removeItem(key: string): Promise<null>;
    storeIndex(key: string, index: string): Promise<any>;
    fetchIndex(key: string): Promise<any[]>;
    removeIndex(key: string): Promise<null>;
    iterate(iteratorCallback: TiteratorCB): Promise<any>;
    exists(obj: Isanitize, index: any, fieldName: string): Promise<Iexist>;
    collectionSanitize(keys: string[]): Promise<null>;
    keys(): Promise<string[]>;
    clear(): Promise<null>;
}
