import {rename} from 'graceful-fs';
import ErrnoException = NodeJS.ErrnoException;

export const RenameFile = (oldPath: string, newPath: string): Promise<null>=> {
    return new Promise((resolve, reject) => {
        rename(oldPath, newPath, (err: ErrnoException | null) => {
            if (err) {
                return reject(err);
            } else {
                resolve(null);
            }
        });
    });
};
