# [TeDB-Electron-Storage](https://github.com/tedb-org/tedb-electron-storage)
A storage driver for electron using [TeDB](https://github.com/tedb-org/teDB) as the the datastore.

## Installation

```bash
$ npm install --save @qiyangxy/tedb-electron-storage
>
$ yarn add @qiyangxy/tedb-electron-storage

```

## Usage
TeDB-Electron-Storage is a storage driver for [TeDB](https://github.com/tedb-org/teDB) that interacts with the base file system of Linux/Mac(OS)/Windows Desktop file systems to save and retrieve data. Together [TeDB](https://github.com/tedb-org/teDB) and this package make a MongoDB like database to save, retrieve, and edit data safely and quickly. This is a persist only storage driver meaning that the data does not live on in memory. It simply retrieves and returns data read from the segment log on the file system.

Since 0.8.0 every collection is an **append-only segment log**: writes are one sequential append (group-committed fsync), the previous generation of every key stays in the log as its backup (no copy on update), and per-record CRCs make crash-torn tails and external corruption detectable and recoverable. This also goes for all indices that are persisted and saved.

It is highly recommended to persist indices often. If not then a good way to remove errors of not having correct indices is to use the sanitize methods on [TeDB](https://github.com/tedb-org/teDB). These methods prevent indices to exist for files that do not exist and for files to not exist if they are not found in the indices. However these sanitize methods will do nothing if there is no index for the collection. 

Since this package relies highly on NodeJS's FS module much of the fs methods were written into promises to make use of promise methodologies. Since many instances needed custom work the use of a 3rd party promise fs library was not used.

```typescript
// ES6 options and available extensions
import { IStorageDriverExtended, TiteratorCB, // from the types directory
    ElectronStorage, indexCheck, // the storage driver and index helper
    AppDirectory, IAppDirectory, // from the AppDirectory directory

    // below are all the functions used in the package as utilities
    // and FS replacements
    TruncateFile, OpenFile, MakeDir, CopyFile, AppendFile, CloseFile, FileStat, FileSync, FlushStorage,  IFlushStorageOptions, WriteFile, ReadFile, SafeWrite, safeReadFile,  IsafeReadFileOptions, parseJSON, stringifyJSON, EnsureDataFile, UnlinkFile, ReadDir, RmDir, LStat, CopyAndWrite, safeParse, RenameFile, safeStat, safeDirExists, KeyedQueue, mapPool, IO_LIMIT,
} from 'tedb-electron-storage';
```
Exports with the key term `safe` resolve `false` when a file is missing instead of rejecting; any other error (permissions, reading a directory, ...) rejects so callers can tell "missing" from "broken".

## Table of Contents

* <a href="#installation">Installation</a>
* <a href="#usage">Usage</a>
* <a href="#storage-driver-upfront-info">Storage Driver Upfront Info</a>
* <a href="#using-tedb-and-tedb-electron-storage-in-tandem">Using TeDB and TeDB-Electron-Storage in Tandem</a>
* <a href="#creating-a-db-and-collection">Creating a DB and Collection</a>
* <a href="#utils-and-benefits-of-this-storage-driver">Utils and Benefits of this Storage Driver</a>


## Storage Driver Upfront Info
Since the use of this package is through [TeDB](https://github.com/tedb-org/teDB) then the explanation will be examples of using [TeDB](https://github.com/tedb-org/teDB) to create a meaningful api for your collections. This explanation will also be written in TypeScript; if you are using regular Javascript, nothing will change except possibly needing to downgrade the ES version to ES5 and removing the type annotations which come after a `:`.

Writes are one sequential append to the active segment with a group-committed fsync — orders of magnitude cheaper than a file create + rename per document. Reads are an in-memory directory lookup plus one positioned read (CRC-verified), and `keys()`/`exists()` never touch the disk at all. Compaction reclaims space from overwritten generations automatically.

## Concurrency and crash safety (0.8.0)

* **Per-key serialization** — `setItem`/`getItem`/`removeItem` (and the index equivalents) targeting the same key run in submission order through an in-process queue; operations on different keys stay fully parallel. Recovery can therefore never race a concurrent write.
* **Atomic visibility** — appends are serialized through the engine's write chain and a record only becomes visible through the in-memory key directory, so a reader never observes a torn record: CRCs catch crash-torn tails (truncated at startup) and externally corrupted bytes (repaired from the previous generation).
* **Group commit** — strict durability shares one fsync across concurrent writers (2 ms window / 1 MiB / 256 ops triggers); relaxed durability bounds its loss window to ~1 s with a fallback fsync.
* **Single-instance guard** — the manifest records the owning process; opening a collection held by a live other process is refused instead of corrupting the log.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full data flow, on-disk layout, recovery semantics and concurrency model.

## Building and testing

```bash
pnpm install
pnpm test:coverage   # fast tiers + coverage threshold gates (~22s) — run this every change
pnpm test            # jest: unit + concurrency + large-scale + tedb integration (auto-skips without tedb)
pnpm build           # vite (lib mode) -> dist/ (index.js CJS bundle + index.d.ts)
pnpm typecheck       # tsc --noEmit
pnpm test:large      # only the large-scale suite (set TEDB_LARGE_N to scale, e.g. 100000)
```

The suite covers 97% of statements / 91% of branches; `pnpm test:coverage`
fails when those numbers regress (thresholds live in `jest.config.js`). See
[docs/TESTING.md](docs/TESTING.md) for the test layout, the recovery-semantics
contract every method must preserve, and how to add cases, and
[CHANGELOG.md](CHANGELOG.md) for release history.

As for the saving location on your desktop, you can check out the AppDirectory directory and read the index file.
* For Mac your data will be saved at `user/Library/ApplicationSupport/dbName`.
* For Windows `user\AppData\Local\dbName`.
* And for linux `user/.local/share/dbName`.
* Or wherever you point it at by passing a custom directory as the third constructor argument: `new ElectronStorage(dbName, collectionName, dataDir)`.

### Durability levels

The fourth constructor argument tunes the crash-safety/performance trade-off of writes:

```typescript
new ElectronStorage(dbName, collectionName, dataDir, {durability: 'relaxed'});
```

* **`'strict'` (default)** — writes are group-committed: concurrent writers share one fsync of the active segment (fired within 2 ms, or immediately at 1 MiB / 256 buffered ops). A write only resolves once its fsync has, so a confirmed write survives power loss.
* **`'relaxed'`** — no per-write fsync; the active segment is still synced at least once per second, bounding the loss window to roughly one second. Records are CRC-checked either way, so a power loss can drop the last writes but never tear one.

### Backup generations (logHistory)

```typescript
new ElectronStorage(dbName, collectionName, dataDir, {logHistory: 0});
```

* **`logHistory: 1` (default)** — the log keeps the previous generation of every key, so a CRC-damaged current record is repaired from it on the next read.
* **`logHistory: 0`** — only the current generation is kept across compaction: the least disk, but a damaged record means the key is gone.

There you can query your data within that directory. A db for your application might look like 
```text
 > collectionName -> name of your db
      |
       > db -> db dir for possible db duplications or other version extensions in the future 
      .  | 
      .   > users -> collection you named and pushed data to
      .  .    | 
      .  .     > manifest.json -> segment list + owner pid + next generation
      .  .     > segments
      .  .     .    |
      .  .     .     > seg-000001.log -> append-only record stream
      .  .     .     > seg-000002.log -> rolled segment (sealed once full)
      .   > otherCollections...    
``` 

Every record inside a segment carries a CRC and a monotonically rising generation number. The memory key directory maps each key to its latest generation (and, with the default `logHistory: 1`, the previous one — that is the backup). Compaction rewrites the surviving generations into a fresh segment and retires the old ones, so the file count stays proportional to your data size rather than your write count.

This package makes use of graceful-fs to prevent many common errors with file accessing. If a find without an index over a very large collection feels slow, that is tedb scanning documents in memory — add an index for the fields you filter on.

## Using TeDB and TeDB-Electron-Storage in Tandem
It is important to understand that [TeDB](https://github.com/tedb-org/teDB) is simply the in memory handler of the indices and _ids which are the keys to files in this package; and that TeDB-Electron-Storage is used for file IO operations. Using both together in certain circumstances and at the right time is key to creating a robust api for your DB. During development it is useful to have the Storage driver's methods available for debugging your DB. However it is not recommended unless completely confident in your ability to use the Storage Driver methods except for the `removeIndex` method.

## Creating a DB and Collection
To view the the methods available to you visit the `types/index` file and look through methods and their descriptions. They should explain their purpose. If not this go through of a good DB collection should be useful.

Here I will create class to describe a collection and what DB it should be apart of. Along with promise based events.
```typescript
// imports
import {ElectronStorage, IStorageDriverExtended} from 'tedb-electron-storage';
import {Datastore, Cursor, IindexOptions, IupdateOptions, Index} from 'tedb';
//
// type and default for event
export type Tevent = (obj: any) => Promise<any>;
const ret = (i: any): Promise<any> => new Promise((resolve) => resolve(i));
export const PRESAVE = 'preSave';
export const POSTSAVE = 'postSave';
export const PREUPDATE = 'preUpdate';
export const POSTUPDATE = 'postUpdate';
export const PREFETCH = 'preFetch';
export const POSTFETCH = 'postFetch';
export const PREREMOVE = 'preRemove';
export const POSTREMOVE = 'postRemove';
export const PREPOST = 'prePost';
export const POSTPOST = 'postPost';
//
// class interface 
export interface ICollection {
    Storage: IStorageDriverExtended;
    Datastore: Datastore;
    collName: string;
    get(query: any): Promise<any>;
    save(doc: any): Promise<any>;
    find(query: any): Cursor;
    count(query: any): Cursor;
    update(query: any, operation: any, options: IupdateOptions): Promise<any>;
    remove(query: any): Promise<number>;
    indexField(options: IindexOptions): Promise<null>;
    removeIndex(fieldName: string): Promise<null>;
    PersistIndices(): Promise<null>;
    PersistIndex(fieldName: string): Promise<null>;
    LoadIndex(key: string, index: any[]): Promise<null>;
    getIndices(): Promise<any>;
}
//
// Events for collection
export interface Ievents {
    preSave: Tevent;
    postSave: Tevent;
    preUpdate: Tevent;
    postUpdate: Tevent;
    preFetch: Tevent;
    postFetch: Tevent;
    preRemove: Tevent;
    postRemove: Tevent;
    preSync: Tevent;
    postSync: Tevent;
    prePost: Tevent;
    postPost: Tevent;
    [key: string]: Tevent;
}
//
// class  
export class Collection implements ICollection {
    public Storage: IStorageDriverExtended;
    public Datastore: Datastore;
    public events: Ievents;
    public collName: string;
    
    constructor(collection: string) {
        this.Storage = new ElectronStorage('YourDBName', collection);
        this.Datastore = new Datastore({storage: this.Storage});
        this.collName = collection;
        this.events = {
            preSave: ret,
            postSave: ret,
            preUpdate: ret,
            postUpdate: ret,
            preFetch: ret,
            postFetch: ret,
            preRemove: ret,
            postRemove: ret,
            preSync: ret,
            postSync: ret,
            prePost: ret,
            postPost: ret,
        };
    }  
    /**
     * Set the method an event should use.
     * @param {string} event
     * @param {Tevent} cb
     */
    public setEvent(event: string, cb: Tevent) {
        this.events[event] = cb;
    }

    /**
     * Depending on the given string execute an event method
     * @param {string} event
     * @param param
     * @returns {Promise<any>}
     */
    public event(event: string, param: any): Promise<any> {
        return this.events[event](param);
    }
    
    /**
     * return only one document. doc as any needed because
     * return type of the find method is number | Promise<any>
     * @param query
     * @returns {Promise<any>}
     */
    public get(query: any): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            let document: any;
            this.event(PREFETCH, query)
                .then(() => this.Datastore.find(query).limit(1).exec())
                .then((doc) => {
                    document = doc;
                    return this.event(POSTFETCH, document[0]);
                })
                .then(() => resolve(document[0]))
                .catch(reject);
        });
    }

    /**
     * Persist a document
     * @param doc
     * @returns {Promise<any>}
     */
    public save(doc: any): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            let document: any;
            this.event(PRESAVE, doc)
                .then((changedDoc) => {
                    return this.Datastore.insert(changedDoc);
                })
                .then((res) => {
                    document = res;
                    return  this.event(POSTSAVE, document);
                })
                .then(() => this.PersistIndices())
                .then(() => resolve(document))
                .catch(reject);
        });
    }

    /**
     * Get all documents matching query. uses indices if any
     * @param query
     * @returns {Cursor}
     */
    public find(query: any): Cursor {
        return this.Datastore.find(query);
    }

    /**
     * Get the count of a find query
     * @param query
     * @returns {Cursor}
     */
    public count(query: any): Cursor {
        return this.Datastore.count(query);
    }

    /**
     * Update documents
     * @param query - Uses find method
     * @param operation - $set, $inc, $mul, $unset, $rename
     * @param options - multi, upsert, returnUpdatedDocs
     * @returns {Promise<any>}
     */
    public update(query: any, operation: any, options: IupdateOptions): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            const update = {query, operation, db: this, options};
            let documents: any;
            this.event(PREUPDATE, update)
                .then((updateObj) => this.Datastore.update(updateObj.query, operation, options))
                .then((docs) => {
                    // can't emit post update without returned docs
                    if (options.returnUpdatedDocs) {
                        documents = docs;
                        const postUpdate = {docs, operation, db: this, options};
                        return this.event(POSTUPDATE, postUpdate);
                    } else {
                        return null;
                    }
                })
                .then(() =>  this.PersistIndices())
                .then(() => {
                    if (options.returnUpdatedDocs) {
                        resolve(documents);
                    } else {
                        resolve();
                    }
                })
                .catch(reject);
        });
    }

    /**
     * Removes documents by query. then persist index
     * @param query
     * @returns {Promise<number>}
     */
    public remove(query: any): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            let num: number;
            this.event(PREREMOVE, query)
                .then(() => this.Datastore.remove(query))
                .then((res) => {
                    num = res;
                    return this.Datastore.sanitize();
                })
                .then(() => this.event(POSTREMOVE, query))
                .then(() => this.PersistIndices())
                .then(() => {
                    if (num) {
                        resolve(num);
                    } else {
                        resolve();
                    }
                })
                .catch(reject);
        });
    }

    /**
     * Create index on a field of a document. can be nested 'path.to.key'
     * @param options - fieldName, unique, compareKeys, checkKeyEquality
     * @returns {Promise<null>}
     */
    public indexField(options: IindexOptions): Promise<null> {
        return new Promise<null>((resolve, reject) => {
            this.Datastore.ensureIndex(options)
                .then(resolve)
                .catch(reject);
        });
    }

    /**
     * Deletes index from memory and from storage
     * @param fieldName
     * @returns {Promise<null>}
     */
    public removeIndex(fieldName: string): Promise<null> {
        return new Promise<null>((resolve, reject) => {
            this.Datastore.removeIndex(fieldName)
                .then(() => this.Storage.removeIndex(fieldName)) // here is where you would use removeIndex from the Storage Driver
                .then(resolve)
                .catch(reject);
        });
    }

    public PersistIndices(): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            this.getIndices()
                .then((indices) => {
                    const promises: Array<Promise<null>> = [];                    
                    indices.forEach((v: Index, k: string) => {
                        promises.push(this.Datastore.saveIndex(k));
                    });
                    return Promise.all(promises);
                })
                .then(resolve)
                .catch(reject);
        });
    }

    /**
     * Persist an index to storage
     * @param fieldName
     * @returns {Promise<null>}
     * @constructor
     */
    public PersistIndex(fieldName: string): Promise<null> {
        return new Promise<null>((resolve, reject) => {
            this.Datastore.saveIndex(fieldName)
                .then(resolve)
                .catch(reject);
        });
    }

    /**
     * Insert a stored index into the datastore, best used with
     * fetch index then, ensureIndex, then load Index if exists.
     * @param key
     * @param index
     * @returns {Promise<null>}
     * @constructor
     */
    public LoadIndex(key: string, index: any[]): Promise<null> {
        return this.Datastore.insertIndex(key, index);
    }

    /**
     * Return the indices of this datastore is a Map
     * @returns {Promise<any>}
     */
    public getIndices(): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            this.Datastore.getIndices()
                .then(resolve)
                .catch(reject);
        });
    }
}
```

If You would like after using the `this.Datastore.getIndices` method it returns the Map of indices you may choose to use this to loop over the indices
```typescript
.then((indices) => {
   return Promise.all(Array.from(indices).map(([key, value]) => {
       // here the value is the Index from TeDB
       // and key is the key for the index ie: username.
       // this is used in the remove method of TeDB to remove an index item from
       // each index
       return value.remove(document); // which document is the document to be removed
   })) 
})
```

Here for example I will show the method for a `Users` collection.
```typescript
import { FieldIndexer, IndexLoader, IndexChecker, PRESYNC, POSTSYNC, Collection} from './DB'; // DB is where the DB above is

export const USERS: string = 'Users';

const User: Collection = new Collection(USERS);
const uniqIndices: string[] = ['username'];
const nonUniqIndices: string[] = ['age'];
//
// promise for event fired
const promise1 = (col: Collection): Promise<null> => { // has to resolve null
    return new Promse((resolve, reject) => {
        return null; // here you could do operation on the collection on events
    });
};
const promise2 = promise1;
//
// adding event to the collection
User.setEvent(PRESYNC, promise1);
User.setEvent(POSTSYNC, promise2);
// 
//
export const Users = (): Promise<Collection> => {
    return new Promise<Collection>((resolve, reject) => {
        let hasIndex: boolean;
        IndexChecker(User) // possible method to check if User has any indices in storage on load up of Database
            .then((bool) => {
                hasIndex = bool;
                if (bool) {
                    return User;
                } else {
                    return FieldIndexer(User, uniqIndices, true); // would ensure you index
                }
            })
            .then((col) => FieldIndexer(User, nonUniqIndices, false)) // ensure another
            .then((col) => {
                if (hasIndex) {
                    return col;
                } else {
                    return IndexLoader(col as Collection, uniqIndices); // load index from storage. -> col.Storage.fetchIndex !! another time to use the Storage Driver method directly
                }
            })
            .then(resolve)
            .catch(reject);
    });
};
```

## Utils and Benefits of this Storage Driver
The utilities are very much tied to this package and don't see much being updated to them unless more error handling fixes come about. Some methods will be removed from this package and other packages under the tedb-org to create a new tedb-org/tedb-utils package in the future which will have all the utils and their tests all on one localized place. 

The benefits of using this package and TeDB are that it is written in TypeScript and all the types are available. Also TypeScript can be used to create an `interface` or `type` that acts as a schema for your collection. Once you query data you simply state the return type as the `type/interface` you declared. TeDB and this package will store your object exactly as you send it so there are no modifications to your object during save. 

There is one thing I have to say about this package and that is don't blame the package right away for errors and issues. When creating your own database logically think about the way it is functioning before submitting an error. 

This package and TeDB are both being used in production for Electron. As issues come up we will be available to discussion and fixes if need be. If this package does not suite your needs please create your own and make a pull request to TeDB to add it to our list of Storage Drivers. A React Native storage driver is in the future so keep an eye out.
