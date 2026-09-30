import {CopyFile, SafeWrite} from './index';
import type {TDurability} from '../types';

/**
 * Used to copy a file and then write to the src new data.
 * @param {string} dest
 * @param {string} src
 * @param data
 * @param {TDurability} durability
 * @returns {Promise<any>}
 * @constructor
 */
export const CopyAndWrite = (src: string, dest: string,  data: any, durability: TDurability = 'strict'): Promise<any> => {
    return new Promise((resolve, reject) => {
        return CopyFile(src, dest)
            .then(() => SafeWrite(src, data, durability))
            .then(resolve)
            .catch((err) => {
                return reject(new Error(':::Storage::: CopyAndWrite Error. ' + err.message));
            });
    });
};
