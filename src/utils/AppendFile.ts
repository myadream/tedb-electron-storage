import {appendFile} from 'graceful-fs';

export interface IAppendFileOptions {
    encoding?: BufferEncoding | null;
    mode?: number;
    flag?: string;
}

export const AppendFile = (file: string | Buffer | number, data: string | Buffer, options?: IAppendFileOptions): Promise<null> => {
    return new Promise((resolve, reject) => {
        const Options: IAppendFileOptions = {};
        if (!options) {
            Options.encoding = 'utf8';
            Options.mode = 0o666;
            Options.flag = 'a';
        } else {
            // keep caller-provided values, default only the missing ones
            Options.encoding = options.encoding || 'utf8';
            Options.mode = options.mode || 0o666;
            Options.flag = options.flag || 'a';
        }
        appendFile(file, data, Options, (err) => {
            if (err) {
                reject(new Error(':::Storage::: AppendFile Error. ' + err.message));
            } else {
                resolve(null);
            }
        });
    });
};
