import {unlink} from 'graceful-fs';

/**
 * Delete a file, tolerating a missing file (ENOENT) so "delete if exists"
 * call sites stay simple. Every other error rejects — the old implementation
 * resolved unconditionally, hiding real failures such as EPERM on Windows.
 */
export const UnlinkFile = (path: string | Buffer): Promise<null> => {
    return new Promise((resolve, reject) => {
        unlink(path, (err) => {
            if (err && err.code !== 'ENOENT') {
                return reject(new Error(':::Storage::: UnlinkFile Error. ' + err.message));
            }
            resolve(null);
        });
    });
};
