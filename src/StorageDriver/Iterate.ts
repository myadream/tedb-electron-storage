import {IStorageDriverExtended, TiteratorCB} from '../types';
import {ReadDir, safeReadFile, safeParse, UnlinkFile, RmDir, CopyFile, safeDirExists, mapPool, IO_LIMIT} from '../utils';
const path = require('path');

const removeAll = (current: string, backup: string): Promise<null> => {
    return new Promise((resolve, reject) => {
        return UnlinkFile(path.join(backup, 'past'))
            .then(() => RmDir(backup))
            .then(() => UnlinkFile(current))
            .then(resolve)
            .catch(reject);
    });
};

const iterateAndReplace = (current: string, backup: string, iterator: TiteratorCB, data: any): Promise<any> => {
    return new Promise((resolve, reject) => {
        return CopyFile(path.join(backup, 'past'), current)
            .then((): any => {
                if (data.hasOwnProperty('_id')) {
                    return iterator(data, data._id);
                }
                return undefined;
            })
            .then(resolve)
            .catch(reject);
    });
};

const readandReplaceParse = (rawData: any, currentFile: string, backup: string, iterator: TiteratorCB): Promise<any> => {
    return new Promise((resolve, reject) => {
        return safeParse(rawData)
            .then((dataBool) => {
                if (dataBool === false) {
                    // cant read. delete all
                    return removeAll(currentFile, backup);
                } else {
                    // can read - iterate and replace
                    return iterateAndReplace(currentFile, backup, iterator, dataBool);
                }
            })
            .then(resolve)
            .catch(reject);
    });
};

const readAndReplace = (currentFile: string, backup: string, iterator: TiteratorCB): Promise<any> => {
    return new Promise((resolve, reject) => {
        return safeReadFile(path.join(backup, 'past'))
            .then((rawData): Promise<any> => {
                if (rawData === false) {
                    return new Promise((rs) => rs(undefined));
                } else {
                    return readandReplaceParse(rawData, currentFile, backup, iterator);
                }
            })
            .then(resolve)
            .catch(reject);
    });
};

const rmBoth = (backup: string, currentFile: string): Promise<null> => {
    return new Promise((resolve, reject) => {
        return RmDir(backup)
            .then(() => UnlinkFile(currentFile))
            .then(resolve)
            .catch(reject);
    });
};

const checkNext = (backup: string, currentFile: string, iterator: TiteratorCB): Promise<any> => {
    return new Promise((resolve, reject) => {
        return safeReadFile(path.join(backup, 'past'))
            .then((databool): Promise<any> => {
                if (databool === false) {
                    return rmBoth(backup, currentFile);
                } else {
                    return readAndReplace(currentFile, backup, iterator);
                }
            })
            .then(resolve)
            .catch(reject);
    });
};

const checkBackup = (currentFile: string, key: string, Storage: IStorageDriverExtended, iterator: TiteratorCB): Promise<any> => {
    return new Promise((resolve, reject) => {
        const backup = path.join(Storage.collectionPath, Storage.version, 'states', key);
        return safeDirExists(backup)
            .then((databool): Promise<any> => {
                if (databool === false) {
                    return UnlinkFile(currentFile);
                } else {
                    return checkNext(backup, currentFile, iterator);
                }
            })
            .then(resolve)
            .catch(reject);
    });
};

const continueReadParse = (data: any, key: string, filename: string, iterator: TiteratorCB, Storage: IStorageDriverExtended): Promise<any> => {
    return new Promise((resolve, reject) => {
        return safeParse(data)
            .then((dataBool) => {
                if (dataBool === false) {
                    // check backup — recovery mutates files, so serialize it
                    // against in-flight writes on the same key
                    return Storage.operationQueue.enqueue(key, () => checkBackup(filename, key, Storage, iterator));
                } else {
                    if (dataBool.hasOwnProperty('_id')) {
                        return iterator(dataBool, dataBool._id);
                    } else {
                        return new Promise((res) => res(undefined));
                    }
                }
            })
            .then(resolve)
            .catch(reject);
    });
};

const readParseIterate = (filename: string, iterator: TiteratorCB, key: string, Storage: IStorageDriverExtended): Promise<any> => {
    return new Promise((resolve, reject) => {
        return safeReadFile(filename)
            .then((data): Promise<any> => {
                if (data === false) {
                    return new Promise((rs) => rs(undefined));
                } else {
                    return continueReadParse(data, key, filename, iterator, Storage);
                }
            })
            .then(resolve)
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

const actualRead = (baseLocation: string, iteratorCallback: TiteratorCB, Storage: IStorageDriverExtended): Promise<any> => {
    return new Promise((resolve, reject) => {
        let broken = false;
        return ReadDir(baseLocation)
            .then((files) => {
                const filteredFiles = files.filter(isDocumentFile);
                // bounded fan-out; once the callback returns truthy (contract:
                // break iteration) no further files are picked up by workers
                return mapPool(filteredFiles, IO_LIMIT, (file) => {
                    if (broken) {
                        return Promise.resolve(null);
                    }
                    const stringedFile = String(file);
                    const filename = path.join(baseLocation, stringedFile);
                    const key = stringedFile.substr(0, stringedFile.indexOf('.'));
                    return readParseIterate(filename, iteratorCallback, key, Storage)
                        .then((cbResult) => {
                            if (cbResult) {
                                broken = true;
                            }
                            return cbResult;
                        });
                });
            })
            .then(resolve)
            .catch(reject);
    });
};

export const Iterate = (iteratorCallback: TiteratorCB, Storage: IStorageDriverExtended): Promise<any> => {
    return new Promise((resolve, reject) => {
        const baseLocation = Storage.collectionPath;
        return safeDirExists(baseLocation)
            .then((databool) => {
                if (databool === false) {
                    console.log(`:::Storage::: No directory at ${baseLocation}`);
                    return new Promise((res) => res(undefined));
                } else {
                    // dir exists
                    return actualRead(baseLocation, iteratorCallback, Storage);
                }
            })
            .then(resolve)
            .catch(reject);
    });
};
