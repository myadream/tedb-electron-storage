import {IStorageDriverExtended} from '../types';
import {ReadDir, UnlinkFile, RmDir, safeDirExists, mapPool, IO_LIMIT} from '../utils';
const path = require('path');

const removeAll = (dirLocation: string, base: string, key: string, Storage: IStorageDriverExtended): Promise<null> => {
    return new Promise((resolve, reject) => {
        return safeDirExists(path.join(dirLocation, key))
            .then((bool) => {
                if (bool === false) {
                    return UnlinkFile(path.join(base, `${key}.db`));
                } else {
                    return UnlinkFile(path.join(dirLocation, key, 'past'))
                        .then(() => RmDir(path.join(dirLocation, key)))
                        .then(() => UnlinkFile(path.join(base, `${key}.db`)));
                }
            })
            .then(() => {
                Storage.untrackKey(key);
                resolve(null);
            })
            .catch(reject);
    });
};

/**
 * Keep only real document files: skip index files, the version directory and
 * atomic-write temp files.
 */
const isDocumentFile = (file: string): boolean => {
    const name = String(file);
    return !name.includes('index_') && !name.includes('`v') && name.endsWith('.db');
};

const checkDir = (keys: string[], base: string, dir: string, Storage: IStorageDriverExtended): Promise<null> => {
    return new Promise((resolve, reject) => {
        return ReadDir(base)
            .then((files) => {
                const filteredKeys = files.filter(isDocumentFile).map((file) => {
                    return String(file).substr(0, String(file).indexOf('.'));
                });
                const doomed = filteredKeys.filter((key) => keys.indexOf(key) === -1);
                // removals mutate both files and the in-memory key cache: run
                // them on each key's queue so they cannot race a concurrent
                // write to the same key, and cap the fan-out for big disks
                return mapPool(doomed, IO_LIMIT, (key) => {
                    return Storage.operationQueue.enqueue(key, () => removeAll(dir, base, key, Storage));
                });
            })
            .then(() => resolve(null))
            .catch(reject);
    });
};

export const CollectionSanitize = (keys: string[], Storage: IStorageDriverExtended): Promise<null> => {
    return new Promise((resolve, reject) => {
        // read all files in directory
        // does this file key exist in keys?
        // if yes no-op
        // else remove backup and base
        const baseLocation = Storage.collectionPath;
        const dirLocation = path.join(baseLocation, Storage.version, 'states');
        return safeDirExists(baseLocation)
            .then((bool): Promise<null> => {
                if (bool === false) {
                    return new Promise((res) => res(null));
                } else {
                    return checkDir(keys, baseLocation, dirLocation, Storage);
                }
            })
            .then(resolve)
            .catch(reject);
    });
};
