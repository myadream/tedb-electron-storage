import {ElectronStorage, IElectronStorageOptions} from '../src';
import {mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync} from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ITestContext {
    storage: ElectronStorage;
    rootDir: string;
    collectionPath: string;
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

export const fileExists = (p: string): boolean => existsSync(p);

export const readRaw = (p: string): string => readFileSync(p, 'utf8');

export const readJsonFile = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));

export const writeRaw = (p: string, content: string): void => writeFileSync(p, content, 'utf8');

export const doc = (id: string, extra: any = {}): any => ({_id: id, ...extra});

/** The empty-index placeholder tedb keeps for an index with no keys. */
export const EMPTY_INDEX = JSON.stringify([{key: null, value: []}]);

/** A non-empty index payload (two keyed entries). */
export const nonEmptyIndex = (extra: string[] = ['id2']): string =>
    JSON.stringify([{key: 'a', value: ['id1', ...extra]}]);

/** 'log' engine layout. */
export const logManifest = (ctx: ITestContext): string =>
    path.join(ctx.collectionPath, 'manifest.json');

export const logSegmentsDir = (ctx: ITestContext): string =>
    path.join(ctx.collectionPath, 'segments');
