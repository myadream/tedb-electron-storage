import {stat, Stats} from 'graceful-fs';
import ErrnoException = NodeJS.ErrnoException;

export const safeStat = (path: string | Buffer): Promise<Stats | boolean> => {
    return new Promise((resolve, reject) => {
        try {
            stat(path, (err: ErrnoException | null, stats: Stats) => {
                if (err) {
                    // for missing file — match on code: the numeric errno differs
                    // between platforms (-2 on POSIX, -4058 on Windows)
                    if (err.code === 'ENOENT') {
                        resolve(false);
                    } else {
                        return reject(err);
                    }
                } else {
                    resolve(stats);
                }
            });
        } catch (e) {
            return reject(e);
        }
    });
};
