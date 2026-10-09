import {ILogState} from './state';
import {tryRead} from './read';
import {waitForCompaction} from './Compact';
import type {IEngineValue} from '../Engine/IEngine';

/**
 * Scan every live key, feeding (value, key) to the callback; a truthy
 * callback result breaks iteration. Damaged records go through `repair`
 * (the driver runs it on the key's queue) exactly like getItem.
 */
export const iterate = async (
    state: ILogState,
    callback: (value: any, key: string) => any,
    repair: (key: string) => Promise<IEngineValue | undefined>,
): Promise<void> => {
    await waitForCompaction(state);
    let broken = false;
    for (const key of [...state.keydir.keys()]) {
        if (broken) {
            break;
        }
        const entry = state.keydir.get(key);
        if (!entry) {
            continue;
        }
        let res = await tryRead(state, entry);
        if (!res) {
            res = await repair(key);
        }
        if (!res) {
            continue;
        }
        const doc = res.value;
        if (doc !== null && typeof doc === 'object' && Object.prototype.hasOwnProperty.call(doc, '_id')) {
            const cbResult = await callback(doc, key);
            if (cbResult) {
                broken = true;
            }
        }
    }
};
