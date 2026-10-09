import {IStorageDriverExtended, Iexist, Isanitize, TDurability, IElectronStorageOptions} from '../types';
import {KeyedQueue, stringifyJSON} from '../utils';
import {createEngine, IEngine} from '../Engine';
import {indexCheck} from './IndexCheck';
import {AppDirectory} from '../AppDirectory/index';
const path = require('path');

export class ElectronStorage implements IStorageDriverExtended {
    public allKeys: string[];
    public allKeysSet: Set<string>;
    public collectionPath: string;
    public collection: string;
    public dbName: string;
    public durability: TDurability;
    public appDirectory: AppDirectory;
    public operationQueue: KeyedQueue;

    private readonly logSegMaxBytes?: number;
    private readonly logHistory?: 0 | 1;
    private readonly logCompactDeadRatio?: number;
    private readonly logCompactMinDeadBytes?: number;
    /** Lazily opened engine — opening scans segments and takes the pid lock. */
    private engineP?: Promise<IEngine>;

    /**
     * @param {string} db - database name (top level directory under the data dir)
     * @param {string} [dir] - optional custom data directory; defaults to the
     *        OS user-data location (e.g. ~/AppData/Local/<db> on Windows)
     * @param {string} collection - collection name (sub directory of db)
     * @param {IElectronStorageOptions} [options] - `durability: 'strict'`
     *        (default) group-commits an fsync per confirmed write; `'relaxed'`
     *        bounds the loss window to ~1 s with a fallback fsync. The
     *        `log*` options tune the segment log (see IElectronStorageOptions).
     */
    constructor(db: string, collection: string, dir?: string | null, options?: IElectronStorageOptions) {
        this.dbName = db;
        this.collection = collection;
        this.appDirectory = new AppDirectory(db, dir == null ? null : dir);
        this.operationQueue = new KeyedQueue();
        this.durability = options?.durability ?? 'strict';
        this.logSegMaxBytes = options?.logSegMaxBytes;
        this.logHistory = options?.logHistory;
        this.logCompactDeadRatio = options?.logCompactDeadRatio;
        this.logCompactMinDeadBytes = options?.logCompactMinDeadBytes;
        this.allKeys = [];
        this.allKeysSet = new Set();
        this.collectionPath = path.join(this.appDirectory.userData(), 'db', this.collection);
    }

    /** Open (once) and hand the engine to the operation. */
    private withEngine<T>(fn: (eng: IEngine) => T | PromiseLike<T>): Promise<T> {
        if (!this.engineP) {
            this.engineP = createEngine(this.collectionPath, {
                durability: this.durability,
                segMaxBytes: this.logSegMaxBytes,
                history: this.logHistory,
                compactDeadRatio: this.logCompactDeadRatio,
                compactMinDeadBytes: this.logCompactMinDeadBytes,
            }).catch((err) => {
                this.engineP = undefined; // allow a retry (e.g. after the holder exited)
                throw err;
            });
        }
        return this.engineP.then(fn);
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
     * Drop a key after its records are gone. The Set guard makes repeats and
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

    public setItem(key: string, value: any): Promise<any> {
        return this.operationQueue.enqueue(key, () =>
            stringifyJSON(value)
                .then((raw) => this.withEngine((eng) => eng.setItem(key, raw)))
                .then(() => {
                    this.trackKey(key);
                    return value;
                }),
        );
    }

    public getItem(key: string): Promise<any> {
        return this.operationQueue.enqueue(key, () =>
            this.withEngine((eng) => eng.getEntry(key)).then((res) => {
                if (res === undefined) {
                    this.untrackKey(key);
                    return undefined;
                }
                return res.value;
            }),
        );
    }

    public removeItem(key: string): Promise<null> {
        return this.operationQueue.enqueue(key, () =>
            this.withEngine((eng) => eng.dropKey(key)).then(() => {
                this.untrackKey(key);
                return null;
            }),
        );
    }

    public storeIndex(key: string, index: string): Promise<any> {
        return this.operationQueue.enqueue(`index_${key}`, () =>
            stringifyJSON(index).then((raw) => this.withEngine((eng) => eng.setItem(`index_${key}`, raw))),
        );
    }

    public fetchIndex(key: string): Promise<any[]> {
        return this.operationQueue.enqueue(`index_${key}`, () =>
            this.withEngine(async (eng) => {
                const res = await eng.getEntry(`index_${key}`);
                if (res === undefined) {
                    return undefined;
                }
                // the empty-index placeholder is answered with null, matching
                // the historical driver contract
                return indexCheck(res.raw) ? null : res.value;
            }),
        );
    }

    public removeIndex(key: string): Promise<null> {
        return this.operationQueue.enqueue(`index_${key}`, () =>
            this.withEngine((eng) => eng.dropKey(`index_${key}`)).then(() => null),
        );
    }

    public iterate(iteratorCallback: (value: any, key: string, iteratorNumber?: number) => any): Promise<any> {
        return this.withEngine((eng) =>
            eng.iterate(iteratorCallback, (key) => this.operationQueue.enqueue(key, () => eng.getEntry(key))),
        );
    }

    public keys(): Promise<string[]> {
        // the engine's key directory is the only truth — mirror it back
        return this.withEngine((eng) => eng.keys()).then((keys) => {
            this.allKeys = keys;
            this.allKeysSet = new Set(keys);
            return keys;
        });
    }

    public exists(obj: Isanitize, index: any, fieldName: string): Promise<Iexist> {
        return this.operationQueue.enqueue(String(obj.value), () =>
            // zero-IO engine probe; corruption handling lives on the read path
            this.withEngine(async (eng) => ({
                key: obj.key,
                value: obj.value,
                doesExist: eng.has(String(obj.value)),
                index,
                fieldName,
            })),
        );
    }

    public collectionSanitize(keys: string[]): Promise<null> {
        // no orphan files exist; keys tedb does not know are dropped outright
        return this.withEngine((eng) =>
            eng.collectionSanitize(keys, (key) =>
                this.operationQueue.enqueue(key, () => eng.dropKey(key)).then(() => {
                    this.untrackKey(key);
                }),
            ),
        );
    }

    public clear(): Promise<null> {
        // barrier: let in-flight per-key work finish before wiping the state,
        // then keep the instance usable afterwards.
        return this.operationQueue.pending().then(() =>
            this.withEngine((eng) => eng.clear()),
        ).then(() => {
            this.allKeys = [];
            this.allKeysSet = new Set();
            return null;
        });
    }
}
