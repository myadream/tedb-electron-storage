import {IStorageDriverExtended, TDurability} from '../types';
import {stringifyJSON, CopyAndWrite, SafeWrite, WriteNewPastandBase, MakeVersionDirPast, UnlinkFile, safeDirExists, MakeDir, safeStat} from '../utils';
import {makeDirCopy, backupDirWrite} from './';
const path = require('path');

/**
 * Remove the base current file and write empty to backup location
 * @param {string} base
 * @param {string} backupDir
 * @param {string} data
 * @param {TDurability} durability
 * @returns {Promise<null>}
 */
const removeBaseWriteBackup = (base: string, backupDir: string, data: string, durability: TDurability): Promise<null> => {
    return new Promise((resolve, reject) => {
        return safeDirExists(backupDir)
            .then((bool) => {
                if (bool === false) {
                    return MakeDir(backupDir);
                } else {
                    return new Promise((res) => res(null));
                }
            })
            .then(() => UnlinkFile(base))
            .then(() => SafeWrite(path.join(backupDir, 'past'), data, durability))
            .then(resolve)
            .catch(reject);
    });
};

/**
 * An empty index (the placeholder entry tedb keeps for an index with no keys)
 * should not persist a base file. Detected by parsing instead of comparing
 * serialized literals, which the old implementation did — it broke as soon as
 * whitespace or key order differed.
 * @param {string} index
 * @returns {boolean}
 */
export const indexCheck = (index: string): boolean => {
    try {
        const parsed = JSON.parse(index);
        if (!Array.isArray(parsed) || parsed.length !== 1) {
            return false;
        }
        const entry = parsed[0];
        return entry !== null && typeof entry === 'object'
            && entry.key === null
            && Array.isArray(entry.value)
            && entry.value.every((v: any) => v === null || v === undefined);
    } catch (e) {
        return false;
    }
};

export const StoreIndex = (key: string, index: string, Storage: IStorageDriverExtended): Promise<any> => {
    return new Promise((resolve, reject) => {
        const baseLocation = Storage.collectionPath;
        const baseFile = path.join(baseLocation, `index_${key}.db`);
        const fileLocation = path.join(baseLocation, Storage.version, 'states', `index_${key}`);
        /**
         * This is the method used when both are missing -> write data to both files
         * @param {string} StringifiedJSON
         * @returns {Promise<any[]>}
         */
        const returnMany = (StringifiedJSON: string): Promise<any[]> => {
            const allLocations = [baseFile, path.join(fileLocation, 'past')];
            return Promise.all(allLocations.map((writePath) => SafeWrite(writePath, StringifiedJSON, Storage.durability)));
        };
        let stringIndex: string;
        return stringifyJSON(index)
            .then((data) => {
                stringIndex = data;
                // existence probe only: stat instead of reading the whole index
                return safeStat(baseFile);
            })
            .then((statResult) => {
                if (statResult !== false) {
                    // base file exists
                    if (indexCheck(stringIndex)) {
                        // index is empty remove base and write to backup location
                        return removeBaseWriteBackup(baseFile, fileLocation, stringIndex, Storage.durability);
                    }
                    // index is not empty write current to backup and write new to current
                    return backupDirWrite(baseFile, fileLocation, stringIndex, Storage.durability);
                }
                // base file missing — check the backup directory
                return safeDirExists(fileLocation)
                    .then((dirBool) => {
                        if (dirBool === false) {
                            if (indexCheck(stringIndex)) {
                                // neither backup nor base file exists and the index is empty
                                return removeBaseWriteBackup(baseFile, fileLocation, stringIndex, Storage.durability);
                            }
                            if (Storage.lazyBackup) {
                                // first store of this index: base only, backup
                                // appears with the first update
                                return SafeWrite(baseFile, stringIndex, Storage.durability);
                            }
                            // no base and no directory but the index is not empty:
                            // create backup dir and write data to both locations
                            return MakeVersionDirPast(fileLocation, returnMany, stringIndex);
                        }
                        if (indexCheck(stringIndex)) {
                            // current is empty, write empty index to backup
                            return SafeWrite(path.join(fileLocation, 'past'), stringIndex, Storage.durability);
                        }
                        // no base but backup dir exists, write new data to both
                        return WriteNewPastandBase(fileLocation, returnMany, baseFile, stringIndex, Storage.durability);
                    });
            })
            .then(resolve)
            .catch(reject);
    });
};
