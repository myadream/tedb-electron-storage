import type {IEngine, IEngineOptions} from '../Engine/IEngine';
import {createState} from './state';
import {setItem} from './SetItem';
import {getEntry} from './GetItem';
import {dropKey} from './RemoveItem';
import {has} from './Exists';
import {keys} from './Keys';
import {iterate} from './Iterate';
import {collectionSanitize} from './CollectionSanitize';
import {clear} from './Clear';

/**
 * Open the segment-log engine for a collection: build the state bag, run
 * startup recovery (manifest → pid lock → segment scan → orphan cleanup),
 * and hand back the IEngine operations bound to that state. This is the only
 * symbol of this folder the Engine layer consumes.
 */
export const open = async (collectionPath: string, options: Required<IEngineOptions>): Promise<IEngine> => {
    const state = await createState(collectionPath, options);
    return {
        setItem: (key: string, raw: string) => setItem(state, key, raw),
        getEntry: (key: string) => getEntry(state, key),
        dropKey: (key: string) => dropKey(state, key),
        has: (key: string) => has(state, key),
        keys: () => keys(state),
        iterate: (callback, repair) => iterate(state, callback, repair),
        collectionSanitize: (keep, drop) => collectionSanitize(state, keep, drop),
        clear: () => clear(state),
    };
};
