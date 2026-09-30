import {IStorageDriverExtended, Iexist, Isanitize, TDurability, IElectronStorageOptions} from '../types';
import {SetItem, GetItem, Clear, FetchIndex, Iterate, Keys, RemoveIndex, RemoveItem, StoreIndex, Exists, CollectionSanitize} from './index';
import {KeyedQueue} from '../utils';
import {mkdirSync} from 'graceful-fs';
import {AppDirectory} from '../AppDirectory/index';
const path = require('path');

export class ElectronStorage implements IStorageDriverExtended {
    public allKeys: string[];
    public allKeysSet: Set<string>;
    public collectionPath: string;
    public version: string;
    public collection: string;
    public dbName: string;
    public durability: TDurability;
    public lazyBackup: boolean;
    public appDirectory: AppDirectory;
    public operationQueue: KeyedQueue;

    /**
     * @param {string} db - database name (top level directory under the data dir)
     * @param {string} collection - collection name (sub directory of db)
     * @param {string} [dir] - optional custom data directory; defaults to the
     *        OS user-data location (e.g. ~/AppData/Local/<db> on Windows)
     * @param {IElectronStorageOptions} [options] - `durability: 'strict'` (default)
     *        fsyncs every write; `'relaxed'` skips fsyncs but keeps atomic
     *        renames — tear-free, faster, may lose the last writes on power loss.
     *        `lazyBackup` (default true) creates the past backup on a key's first
     *        update instead of its first write; `false` restores the legacy
     *        first-write-duplicates behavior
     */
    constructor(db: string, collection: string, dir?: string | null, options?: IElectronStorageOptions) {
        this.dbName = db;
        this.collection = collection;
        this.appDirectory = new AppDirectory(db, dir == null ? null : dir);
        this.operationQueue = new KeyedQueue();
        this.durability = options?.durability ?? 'strict';
        this.lazyBackup = options?.lazyBackup ?? true;
        this.allKeys = [];
        this.allKeysSet = new Set();
        this.collectionPath = '';
        this.version = '';
        this.ensureDirs();
    }

    /**
     * Record a persisted key. O(1) via the Set mirror; the array is kept for
     * order-stable public access to allKeys.
     */
    public trackKey(key: string): void {
        if (!this.allKeysSet.has(key)) {
            this.allKeysSet.add(key);
            this.allKeys.push(key);
        }
    }

    /**
     * Drop a key after its files are gone. The Set guard makes repeats and
     * never-tracked keys no-ops without rescanning the array.
     */
    public untrackKey(key: string): void {
        if (this.allKeysSet.delete(key)) {
            const i = this.allKeys.indexOf(key);
            if (i !== -1) {
                this.allKeys.splice(i, 1);
            }
        }
    }

    /**
     * Create the on-disk skeleton for this collection. Safe to call again
     * after clear() wiped the directory. `version` keeps its leading backtick
     * on purpose: it is the on-disk layout marker that collection scans
     * (Keys/Iterate/CollectionSanitize) filter on.
     */
    private ensureDirs(): void {
        const userData = this.appDirectory.userData();
        mkdirSync(userData, {recursive: true});
        this.collectionPath = path.join(userData, 'db', this.collection);
        this.version = '`v0.0.1';
        mkdirSync(path.join(this.collectionPath, this.version, 'states'), {recursive: true});
    }

    public setItem(key: string, value: any): Promise<any> {
        return this.operationQueue.enqueue(key, () => SetItem(key, value, this));
    }

    public getItem(key: string): Promise<any> {
        return this.operationQueue.enqueue(key, () => GetItem(key, this));
    }

    public removeItem(key: string): Promise<null> {
        return this.operationQueue.enqueue(key, () => RemoveItem(key, this));
    }

    public storeIndex(key: string, index: string): Promise<any> {
        return this.operationQueue.enqueue(`index_${key}`, () => StoreIndex(key, index, this));
    }

    public fetchIndex(key: string): Promise<any[]> {
        return this.operationQueue.enqueue(`index_${key}`, () => FetchIndex(key, this));
    }

    public removeIndex(key: string): Promise<null> {
        return this.operationQueue.enqueue(`index_${key}`, () => RemoveIndex(key, this));
    }

    public iterate(iteratorCallback: (value: any, key: string, iteratorNumber?: number) => any): Promise<any> {
        return Iterate(iteratorCallback, this);
    }

    public keys(): Promise<string[]> {
        return Keys(this);
    }

    public exists(obj: Isanitize, index: any, fieldName: string): Promise<Iexist> {
        return this.operationQueue.enqueue(String(obj.value), () => Exists(obj, index, fieldName, this));
    }

    public collectionSanitize(keys: string[]): Promise<null> {
        return CollectionSanitize(keys, this);
    }

    public clear(): Promise<null> {
        // barrier: let in-flight per-key work finish before wiping the tree,
        // then recreate the skeleton so the instance stays usable afterwards.
        return this.operationQueue.pending()
            .then(() => Clear(this))
            .then(() => {
                this.allKeys = [];
                this.allKeysSet = new Set();
                this.ensureDirs();
                return null;
            });
    }
}
