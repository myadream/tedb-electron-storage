import {FLAG_TOMBSTONE} from './records';
import {ILogState} from './state';
import {appendRecord, run} from './append';
import {scheduleCompactionIfNeeded} from './Compact';

/**
 * Tombstone a key so the deletion survives restarts, then forget it in both
 * keydir slots. The disk bytes stay until compaction reclaims them.
 */
export const dropKey = async (state: ILogState, key: string): Promise<void> => {
    if (!state.keydir.has(key)) {
        state.prevdir.delete(key);
        return;
    }
    await run(state, async () => {
        await appendRecord(state, key, '', FLAG_TOMBSTONE);
        state.keydir.delete(key);
        state.prevdir.delete(key);
    });
    if (state.opts.durability === 'strict') {
        await state.syncer.flush();
    }
    scheduleCompactionIfNeeded(state);
};
