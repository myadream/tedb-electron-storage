import {FLAG_NONE} from './records';
import {ILogState} from './state';
import {appendRecord, run} from './append';
import {tryRead} from './read';
import {waitForCompaction} from './Compact';
import {dropKey} from './RemoveItem';

/**
 * Read a key's current generation, repairing from the previous one when the
 * current is damaged (crc/parse failure) and dropping the key when both are.
 * Runs on the caller's per-key queue at the driver level.
 */
export const getEntry = async (state: ILogState, key: string): Promise<{raw: string; value: any} | undefined> => {
    await waitForCompaction(state);
    const cur = state.keydir.get(key);
    if (!cur) {
        return undefined;
    }
    const fresh = await tryRead(state, cur);
    if (fresh) {
        return fresh;
    }
    const prev = state.prevdir.get(key);
    if (prev) {
        const old = await tryRead(state, prev);
        if (old) {
            // recovery write: always durable, regardless of the durability
            // option — this is the data-loss edge
            const entry = await run(state, () => appendRecord(state, key, old.raw, FLAG_NONE));
            await state.syncer.flush();
            state.prevdir.delete(key);
            state.keydir.set(key, entry);
            return old;
        }
    }
    await dropKey(state, key);
    return undefined;
};
