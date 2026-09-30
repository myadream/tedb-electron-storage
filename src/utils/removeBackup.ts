import {UnlinkFile, RmDir, safeDirExists} from './index';
const path = require('path');

const unlinkAndRmDir = (file: string, dir: string): Promise<null> => {
    return new Promise((resolve, reject) => {
        return UnlinkFile(file)
            .then(() => RmDir(dir))
            .then(resolve)
            .catch(reject);
    });
};

/**
 * Main method
 * Should remove the backup directory and the backup file
 * @param {string} dirLocation
 * @returns {Promise<any>}
 */
export const removeBackup = (dirLocation: string): Promise<null> => {
    return new Promise((resolve, reject) => {
        return safeDirExists(dirLocation)
            .then((bool): Promise<null> => {
                if (bool === false) {
                    // dir does not exist anyway
                    return new Promise((res) => res(null));
                }
                // UnlinkFile tolerates ENOENT, so a directory without a past
                // file is handled by the same path — no need to read first
                return unlinkAndRmDir(path.join(dirLocation, 'past'), dirLocation);
            })
            .then(resolve)
            .catch((err) => {
                return reject(new Error(':::Storage::: removeBackup Error. ' + err.message));
            });
    });
};
