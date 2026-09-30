import {rmdir} from 'graceful-fs';

export const RmDir = (path: string | Buffer): Promise<null> => {
    return new Promise((resolve, reject) => {
        rmdir(path, (err) => {
            if (err) {
                // errno differs between platforms (-2 on posix, -4058 on win32),
                // so match on the portable error code only.
                if (err.code === 'ENOENT') {
                    resolve(null);
                } else {
                    return reject(new Error(':::Storage::: RmDir Error. ' + err.message));
                }
            } else {
                resolve(null);
            }
        });
    });
};
