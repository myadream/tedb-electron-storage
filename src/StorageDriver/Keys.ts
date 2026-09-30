import {IStorageDriverExtended} from '../types';
import {ReadDir, safeReadFile, RmDir, UnlinkFile, SafeWrite, safeParse, safeDirExists, stringifyJSON, mapPool, IO_LIMIT} from '../utils';
const path = require('path');
import {flattenArr, rmArrDups} from 'tedb-utils';

const removeAll = (dirLocation: string, base: string, key: string): Promise<string[]> => {
    return new Promise((resolve, reject) => {
        return UnlinkFile(path.join(dirLocation, key, 'past'))
            .then(() => RmDir(path.join(dirLocation, key)))
            .then(() => UnlinkFile(path.join(base, `${key}.db`)))
            .then(() => resolve([]))
            .catch(reject);
    });
};

const removeJustbase = (base: string, key: string): Promise<string[]> => {
    return new Promise((resolve, reject) => {
        return UnlinkFile(path.join(base, `${key}.db`))
            .then(() => resolve([]))
            .catch(reject);
    });
};

const RemoveDirectoryAndFile = (base: string, dirLocation: string, key: string): Promise<string[]> => {
    return new Promise((resolve, reject) => {
        return safeDirExists(path.join(dirLocation, key))
            .then((bool): Promise<string[]> => {
                if (bool === false) {
                    return removeJustbase(base, key);
                } else {
                    // directory exists remove dir/file and base
                    return removeAll(dirLocation, base, key);
                }
            })
            .then(resolve)
            .catch(reject);

    });
};

/**
 * Write backup file data to current file location
 * This is possible since the backup was not corrupted and the _id was retrievable.
 * Using the id as the key to locate the current file path write its data to it and
 * return the _id.
 * @param fileData
 * @param {string} baseLocation
 * @returns {Promise<string[]>}
 * @constructor
 */
const WriteBackupToBaseReturn = (fileData: any, baseLocation: string): Promise<string[]> => {
    return new Promise((resolve, reject) => {
        // SafeWrite takes the serialized string — the parsed object it used to
        // receive here made fs.writeFile throw with a TypeError.
        return stringifyJSON(fileData)
            // recovery write: always strict — this is the durability-critical path
            .then((str) => SafeWrite(path.join(baseLocation, `${fileData._id}.db`), str))
            .then(() => resolve([fileData._id]))
            .catch(reject);
    });
};

interface IcomboRead {
    key: string;
    rawData: boolean | string | null;
    read: boolean;
}
const comboFileReadFMethod = (baseLocation: string, key: string): Promise<IcomboRead> => {
    return new Promise((resolve, reject) => {
        return safeReadFile(path.join(baseLocation, `${key}.db`))
            .then((rawData) => {
                if (rawData === false) {
                    resolve({key, rawData: '', read: false});
                } else {
                    resolve({key, rawData, read: true});
                }
            })
            .catch(reject);
    });
};
const comboFileReadMethod = (dirLocation: string, key: string): Promise<IcomboRead> => {
    return new Promise((resolve, reject) => {
        return safeReadFile(path.join(dirLocation, key, 'past'))
            .then((rawData) => {
                if (rawData === false) {
                    resolve({key, rawData: '', read: false});
                } else {
                    resolve({key, rawData, read: true});
                }
            })
            .catch(reject);
    });
};

interface IcomboParse {
    key: string;
    parsedData: any;
    read: boolean;
}

const comboFileParseMethod = (obj: IcomboRead): Promise<IcomboParse> => {
    return new Promise((resolve, reject) => {
        // since incoming data is either null | boolean | string make sure it is string
        // following methods require it.
        if (typeof obj.rawData === 'string') {
            obj.rawData = obj.rawData as string;
        } else {
            obj.rawData = '' as string;
        }
        return safeParse(obj.rawData)
            .then((fileData) => resolve({key: obj.key, parsedData: fileData, read: obj.read}))
            .catch(reject);
    });
};

const checkBackupFile = (dirLocation: string, baseLocation: string, key: string): Promise<string[][]> => {
    return new Promise((resolve, reject) => {
        // the backup directory holds exactly one file ("past"); read it once
        return comboFileReadMethod(dirLocation, key)
            .then((obj: IcomboRead): Promise<IcomboParse> => {
                if (obj.read === false) {
                    return new Promise((rs) => rs({key: obj.key, parsedData: obj.rawData, read: obj.read}));
                } else {
                    return comboFileParseMethod(obj);
                }
            })
            .then((fileData: IcomboParse): Promise<string[]> => {
                if (fileData.parsedData === false) {
                    // this means both current location and backup are unreadable. -> remove both
                    return RemoveDirectoryAndFile(baseLocation, dirLocation, fileData.key);
                } else {
                    // read backup location, write to baselocation then return _id;
                    return WriteBackupToBaseReturn(fileData.parsedData, baseLocation);
                }
            })
            .then((res) => resolve([res]))
            .catch(reject);
    });
};

const checkBackupDir = (dirLocation: string, baseLocation: string, key: string): Promise<string[][]> => {
    return new Promise((resolve, reject) => {
        return safeDirExists(path.join(dirLocation, key))
            .then((bool): Promise<string[][]> => {
                if (bool === false) {
                    // key directory backup does not exits. Remove base
                    // since coming here means that the base location was unparsable
                    return removeBaseButreturnDoubleArr(baseLocation, key);
                } else {
                    // it is found. safe read past file and parse
                    return checkBackupFile(dirLocation, baseLocation, key);
                }
            })
            .then(resolve)
            .catch(reject);
    });
};

const removeBaseButreturnDoubleArr = (base: string, key: string): Promise<string[][]> => {
    return new Promise((resolve, reject) => {
        return UnlinkFile(path.join(base, `${key}.db`))
            .then(() => resolve([[]]))
            .catch(reject);
    });
};

/**
 * Read the backup file to see if it is parsable
 * if So -> return the key and write data to current location
 * if Not -> delete backup. Can not delete current without reference
 * @param {string} dirLocation
 * @param {string} baseLocation
 * @param {IcomboParse} obj
 * @returns {Promise<string[][]>}
 */
const readBackupLocation = (dirLocation: string, baseLocation: string, obj: IcomboParse): Promise<string[][]> => {
    return new Promise((resolve, reject) => {
        return safeDirExists(dirLocation)
            .then((bool): Promise<string[][]> => {
                if (bool === false) {
                    // remove base location file that
                    // was found but unparsable
                    return removeBaseButreturnDoubleArr(baseLocation, obj.key);
                } else {
                    return checkBackupDir(dirLocation, baseLocation, obj.key);
                }
            })
            .then(resolve)
            .catch(reject);
    });
};

/**
 * Keep only real document files: skip index files, the version directory and
 * atomic-write temp files (their names never end in ".db").
 */
const isDocumentFile = (file: string): boolean => {
    const name = String(file);
    return !name.includes('index_') && !name.includes('`v') && name.endsWith('.db');
};

const keyFromFilename = (file: string): string => {
    const name = String(file);
    return name.substr(0, name.indexOf('.'));
};

const readAllDir = (baseLocation: string, dirLocation: string, Storage: IStorageDriverExtended): Promise<string[]> => {
    return new Promise((resolve, reject) => {
        return ReadDir(baseLocation)
            .then((files) => {
                const noIndexFiles = files.filter(isDocumentFile);
                // bounded fan-out: a 100k-file collection must not open every
                // file at once
                return mapPool(noIndexFiles, IO_LIMIT, (dbFile) => {
                    const key = keyFromFilename(dbFile);
                    return comboFileReadFMethod(baseLocation, key);
                });
            })
            .then((filesRawData: IcomboRead[]) => {
                return mapPool(filesRawData, IO_LIMIT, (obj: IcomboRead): Promise<IcomboParse> => {
                    if (obj.read === false) {
                        return new Promise((rs) => rs({key: obj.key, parsedData: obj.rawData, read: obj.read}));
                    } else {
                        return comboFileParseMethod(obj);
                    }
                });
            })
            .then((filesData: IcomboParse[]): Promise<string[][][]> => {
                return mapPool(filesData, IO_LIMIT, (fd): Promise<string[][]> => {
                    if (fd.parsedData === false) {
                        // search backup location for readable files for each file read its directory
                        // -> dir location is -> appName/collection/version/states/ dir / past
                        // recovery deletes/rewrites files: serialize it against any in-flight
                        // write on the same key
                        return Storage.operationQueue.enqueue(fd.key, () => readBackupLocation(dirLocation, baseLocation, fd));
                    } else {
                        // resolve the actual key
                        return new Promise<string[][]>((res) => res([[fd.parsedData._id]]));
                    }
                });
            })
            .then((keys: string[][][]) => {
                const incomingKeys = flattenArr(keys);
                resolve(rmArrDups([...Storage.allKeys, ...incomingKeys]));
            })
            .catch(reject);
    });
};

/**
 * Search for keys. If a key is found test to see if it is parsable. If not search
 * backup location and test if that file is parsable. If not then return null.
 * If so then copy backup to baseLocation then return the backup.
 * @param {string} baseLocation
 * @param {string} dirLocation
 * @param {IStorageDriverExtended} Storage
 * @returns {Promise<string[]>}
 */
const readKeysSafety = (baseLocation: string, dirLocation: string, Storage: IStorageDriverExtended): Promise<string[]> => {
    return new Promise((resolve, reject) => {
        return safeDirExists(baseLocation)
            .then((bool): Promise<string[]> => {
                if (bool === false) {
                    // check backup just like readAllLocations does for the base dir.
                    return new Promise((res) => res([]));
                } else {
                    return readAllDir(baseLocation, dirLocation, Storage);
                }
            })
            .then((keys) => {
                keys = keys.filter((k) => k !== undefined);
                resolve(keys);
            })
            .catch(reject);
    });
};

const readAllLocations = (base: string, dir: string, Storage: IStorageDriverExtended): Promise<string[]> => {
    return new Promise((resolve, reject) => {
        return ReadDir(base)
            .then((files): Promise<string[]> => {
                const filteredFiles = files.filter(isDocumentFile);

                // Trust the in-memory cache only when the on-disk file names
                // match it exactly. The old count-only comparison returned a
                // stale cache whenever a concurrent insert and delete kept the
                // total count unchanged.
                const diskKeys = filteredFiles.map(keyFromFilename);
                const cacheSet = new Set(Storage.allKeys);
                const diskSet = new Set(diskKeys);
                let matchesCache = diskSet.size === cacheSet.size;
                if (matchesCache) {
                    for (const k of diskSet) {
                        if (!cacheSet.has(k)) {
                            matchesCache = false;
                            break;
                        }
                    }
                }
                if (matchesCache) {
                    return new Promise((res) => res(Storage.allKeys));
                } else {
                    return readKeysSafety(base, dir, Storage);
                }
            })
            .then(resolve)
            .catch(reject);
    });
};

const checkKeysLocations = (base: string, dir: string, Storage: IStorageDriverExtended): Promise<string[]> => {
    return new Promise((resolve, reject) => {
        return safeDirExists(base)
            .then((bool): Promise<string[]> => {
                if (bool === false) {
                    // the backup dir is after the base so if no base no backup
                    return new Promise((res) => res([]));
                } else {
                    // base location exists check files and check resulting length
                    return readAllLocations(base, dir, Storage);
                }
            })
            .then((keys) => {
                const filteredKeys = keys.filter((k) => k !== undefined);
                resolve(filteredKeys);
            })
            .catch(reject);
    });
};

/**
 * Main method
 * Keys is a method that should return all the file keys
 * The storage Driver does hold the keys in memory but many occurrences
 * may remove a file from the file system and not remove the key from the
 * Storage driver
 * @param {IStorageDriverExtended} Storage
 * @returns {Promise<any>}
 * @constructor
 */
export const Keys = (Storage: IStorageDriverExtended): Promise<any> => {
    return new Promise((resolve, reject) => {
        const baseLocation = Storage.collectionPath;
        const dirLocation = path.join(baseLocation, Storage.version, 'states');
        if (Storage.allKeys.length === 0) {
            // No keys in Storage driver check file system files
            return readKeysSafety(baseLocation, dirLocation, Storage)
                .then(resolve)
                .catch(reject);
        } else {
            // should check current directories files length should match keys length
            return checkKeysLocations(baseLocation, dirLocation, Storage)
                .then(resolve)
                .catch(reject);
        }
    });
};
