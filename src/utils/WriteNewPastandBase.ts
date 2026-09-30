import {SafeWrite} from './index';
import type {TDurability} from '../types';
const path = require('path');

/**
 * Main method
 * Write data to past and current location
 * @param {string} fileLocation
 * @param {any} returnMany
 * @param {string} baseLocation
 * @param data
 * @param {TDurability} durability
 * @returns {Promise<any>}
 * @constructor
 */
export const WriteNewPastandBase = (fileLocation: string, returnMany: any, baseLocation: string, data: any, durability: TDurability = 'strict'): Promise<any> => {
    return new Promise((resolve, reject) => {
        return SafeWrite(path.join(fileLocation, 'past'), data, durability)
            .then(() => SafeWrite(baseLocation, data, durability))
            .then(resolve)
            .catch((err) => {
                return reject(new Error(':::Storage::: WriteNewPastandBase Error. ' + err.message));
            });
    });
};
