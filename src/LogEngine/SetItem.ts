import {FLAG_NONE} from './records';
import {ILogState} from './state';
import {appendRecord, run} from './append';
import {waitForCompaction, scheduleCompactionIfNeeded} from './Compact';

/**
 * Append the next generation of `key` and move the previous one into the
 * prev slot (history 1) — that slot *is* the backup, no copy involved.
 */
export const setItem = async (state: ILogState, key: string, raw: string): Promise<void> => {
    await waitForCompaction(state);
    await run(state, async () => {
        const entry = await appendRecord(state, key, raw, FLAG_NONE);
        const old = state.keydir.get(key);
        if (old && state.opts.history >= 1) {
            state.prevdir.set(key, old);
        } else if (old) {
            state.prevdir.delete(key);
        }
        state.keydir.set(key, entry);
    });
    if (state.opts.durability === 'strict') {
        await state.syncer.flush();
    } else {
        const fallback = state.syncer.maybeFallback();
        if (fallback) {
            // fire-and-forget: relaxed promises are OS-cache-grade anyway
            fallback.catch(() => undefined);
        }
    }
    scheduleCompactionIfNeeded(state);
};
