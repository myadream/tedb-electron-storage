import {writeFile} from 'graceful-fs';

export interface IWriteFileOptions {
    encoding?: BufferEncoding | null;
    mode?: number;
    flag?: string;
}

export const WriteFile = (file: string | Buffer | number, data: string | Buffer | Uint8Array, options?: IWriteFileOptions): Promise<null> => {
    return new Promise((resolve, reject) => {
        const Options: IWriteFileOptions = {};
        if (!options) {
            Options.encoding = 'utf8';
            Options.mode = 0o666;
            Options.flag = 'w';
        } else {
            // keep caller-provided values, default only the missing ones
            Options.encoding = options.encoding || 'utf8';
            Options.mode = options.mode || 0o666;
            Options.flag = options.flag || 'w';
        }
        writeFile(file, data, Options, (err) => {
            if (err) {
                return reject(new Error(':::Storage::: WriteFile Error. ' + err.message));
            } else {
                resolve(null);
            }
        });
    });
};
