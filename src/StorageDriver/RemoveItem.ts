import {IStorageDriverExtended} from '../types';
import {UnlinkFile, removeBackup, safeStat} from '../utils';
const path = require('path');

/**
 * remove the key from all keys on the Storage driver class
 * and remove the backup file
 * @param {string} key
 * @param {string} fileLocation
 * @param {IStorageDriverExtended} Storage
 * @returns {Promise<any>}
 */
const doesNotExist = (key: string, fileLocation: string, Storage: IStorageDriverExtended): Promise<any> => {
    return new Promise((resolve, reject) => {
        Storage.untrackKey(key);
        return removeBackup(fileLocation)
            .then(resolve)
            .catch(reject);
    });
};

/**
 * Remove both backup and current file then the key off the storage driver class
 * @param {string} key
 * @param {string} baseLocation
 * @param {string} fileLocation
 * @param {IStorageDriverExtended} Storage
 * @returns {Promise<any>}
 */
const doesExist = (key: string, baseLocation: string, fileLocation: string, Storage: IStorageDriverExtended): Promise<any> => {
    return new Promise((resolve, reject) => {
        return removeBackup(fileLocation)
            .then(() => UnlinkFile(path.join(baseLocation, `${key}.db`)))
            .then(() => {
                Storage.untrackKey(key);
                resolve(undefined);
            })
            .catch(reject);
    });
};

/**
 * Main method
 * removing an item should also remove the backup.
 * @param {string} key
 * @param {IStorageDriverExtended} Storage
 * @returns {Promise<any>}
 * @constructor
 */
export const RemoveItem = (key: string, Storage: IStorageDriverExtended): Promise<any> => {
    return new Promise((resolve, reject) => {
        const baseLocation = Storage.collectionPath;
        const fileLocation = path.join(baseLocation, Storage.version, 'states', key);
        return safeStat(path.join(baseLocation, `${key}.db`))
            .then((statResult) => {
                if (statResult === false) {
                    // base file does not exist
                    return doesNotExist(key, fileLocation, Storage);
                } else {
                    // base file does exist
                    return doesExist(key, baseLocation, fileLocation, Storage);
                }
            })
            .then(resolve)
            .catch(reject);
    });
};
