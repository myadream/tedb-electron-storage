import {ElectronStorage, IElectronStorageOptions} from '../src';
import {mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync} from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ITestContext {
    storage: ElectronStorage;
    rootDir: string;
    collectionPath: string;
    statesPath: string;
}

/**
 * Build a storage instance fully isolated in a fresh temp directory — the old
 * specs wrote into the real OS user-data directory.
 */
export const setupStorage = (db: string = 'testdb', collection: string = 'testcol', options?: IElectronStorageOptions): ITestContext => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'tedb-storage-'));
    const storage = new ElectronStorage(db, collection, rootDir, options);
    const collectionPath = path.join(rootDir, db, 'db', collection);
    return {
        storage,
        rootDir,
        collectionPath,
        statesPath: path.join(collectionPath, '`v0.0.1', 'states'),
    };
};

export const teardownStorage = async (ctx: ITestContext): Promise<void> => {
    try {
        await ctx.storage.clear();
    } catch (e) {
        // best effort — rmSync below is the real cleanup
    }
    rmSync(ctx.rootDir, {recursive: true, force: true});
};

export const baseFile = (ctx: ITestContext, key: string): string =>
    path.join(ctx.collectionPath, `${key}.db`);

export const pastFile = (ctx: ITestContext, key: string): string =>
    path.join(ctx.statesPath, key, 'past');

export const indexBaseFile = (ctx: ITestContext, key: string): string =>
    path.join(ctx.collectionPath, `index_${key}.db`);

export const indexPastFile = (ctx: ITestContext, key: string): string =>
    path.join(ctx.statesPath, `index_${key}`, 'past');

export const fileExists = (p: string): boolean => existsSync(p);

export const readRaw = (p: string): string => readFileSync(p, 'utf8');

export const readJsonFile = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));

export const writeRaw = (p: string, content: string): void => writeFileSync(p, content, 'utf8');

/** Simulate corruption the same way the legacy specs did (via append). */
export const corruptFile = (p: string): void => writeFileSync(p, '###corrupted###', 'utf8');

export const doc = (id: string, extra: any = {}): any => ({_id: id, ...extra});

/** Remove a file or a whole subtree; missing paths are fine. */
export const removePath = (p: string): void => rmSync(p, {recursive: true, force: true});

/** The empty-index placeholder tedb keeps for an index with no keys. */
export const EMPTY_INDEX = JSON.stringify([{key: null, value: []}]);

/** A non-empty index payload (two keyed entries). */
export const nonEmptyIndex = (extra: string[] = ['id2']): string =>
    JSON.stringify([{key: 'a', value: ['id1', ...extra]}]);
