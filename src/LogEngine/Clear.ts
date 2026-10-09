import {promises as fsp} from 'graceful-fs';
import {ILogState} from './state';
import {run} from './append';
import {waitForCompaction} from './Compact';
import {createSegment, nextSegmentId} from './recover';
import {writeManifest} from './manifest';

const closeAll = async (state: ILogState): Promise<void> => {
    const all = [...state.segments.values(), ...state.retired];
    for (const seg of all) {
        await seg.fd.close().catch(() => undefined);
    }
    state.segments = new Map();
    state.retired = [];
};

/**
 * Wipe the collection and rebuild an empty single-segment state. The driver
 * holds its queue barrier across this, so no queued op is in flight; a
 * running compaction is awaited first.
 */
export const clear = async (state: ILogState): Promise<void> => {
    await waitForCompaction(state);
    await run(state, async () => undefined);
    await closeAll(state);
    await fsp.rm(state.collectionPath, {recursive: true, force: true});
    state.keydir = new Map();
    state.prevdir = new Map();
    state.nextGen = 1;
    await fsp.mkdir(state.segmentsPath, {recursive: true});
    state.active = await createSegment(state, 1);
    state.segments.set(1, state.active);
    await writeManifest(state);
};
