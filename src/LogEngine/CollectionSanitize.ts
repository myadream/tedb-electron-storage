import {ILogState} from './state';
import {waitForCompaction} from './Compact';

/**
 * Cross-check with tedb's known keys: log collections have no orphan files,
 * so keys the caller does not know are dropped outright (each drop runs on
 * its key's queue via `drop`).
 */
export const collectionSanitize = async (state: ILogState, keep: string[], drop: (key: string) => Promise<void>): Promise<null> => {
    await waitForCompaction(state);
    const keepSet = new Set(keep);
    const doomed = [...state.keydir.keys()].filter((key) => !keepSet.has(key));
    for (const key of doomed) {
        await drop(key);
    }
    return null;
};
