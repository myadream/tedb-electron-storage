import {readFile} from 'graceful-fs';

export interface IsafeReadFileOptions {
    encoding?: BufferEncoding | null;
    flag?: string;
}

/**
 * Read a file, resolving `false` only when the file does not exist.
 * Any other error (EACCES, EISDIR, ...) is rejected so callers can
 * distinguish "missing" from "unreadable" — the old implementation
 * silently reported every error on non-darwin platforms as "missing".
 */
export const safeReadFile = (path: string, options?: IsafeReadFileOptions): Promise<any> => {
    return new Promise((resolve, reject) => {
        const Options: IsafeReadFileOptions = {};
        if (!options) {
            Options.encoding = 'utf8';
            Options.flag = 'r';
        } else {
            // keep caller-provided values, default only the missing ones
            Options.encoding = options.encoding || 'utf8';
            Options.flag = options.flag || 'r';
        }
        readFile(path, Options, (err: any, data: string | Buffer) => {
            if (err) {
                if (err.code === 'ENOENT') {
                    resolve(false);
                } else {
                    return reject(new Error(':::Storage::: safeReadFile Error. ' + err.message));
                }
            } else {
                resolve(data as string);
            }
        });
    });
};
