import {FLAG_NONE, encodeRecord} from './records';
import {IKeyEntry, ILogState} from './state';
import {writeManifest} from './manifest';
import {createSegment, nextSegmentId} from './recover';

/** Run `op` serialized on the engine's write chain; failures stay isolated to the op. */
export const run = <T>(state: ILogState, op: () => Promise<T>): Promise<T> => {
    const result = state.chain.then(op);
    state.chain = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
};

export const rollSegment = async (state: ILogState): Promise<void> => {
    state.active.sealed = true;
    // everything appended to the old active segment is committed before
    // the new one takes over
    if (state.opts.durability === 'strict') {
        await state.active.fd.sync();
    }
    const id = nextSegmentId(state);
    const seg = await createSegment(state, id);
    state.segments.set(id, seg);
    state.active = seg;
    // commit the new (empty) segment to the manifest BEFORE any record
    // lands in it — a crash before this point would orphan it and its
    // records must not exist yet
    await writeManifest(state);
};

/**
 * Append one record to the active segment (rolling first if it would
 * overflow) and account for the group commit. The keydir is updated by the
 * caller — appends on different keys may interleave between the write and
 * the update, and both entry versions stay readable.
 */
export const appendRecord = async (state: ILogState, key: string, value: string, flags: number = FLAG_NONE): Promise<IKeyEntry> => {
    const gen = state.nextGen++;
    const buf = encodeRecord(key, value, gen, flags);
    if (state.active.bytes + buf.length > state.opts.segMaxBytes) {
        await rollSegment(state);
    }
    await state.active.fd.write(buf, 0, buf.length, state.active.bytes);
    const entry: IKeyEntry = {seg: state.active.id, off: state.active.bytes, len: buf.length, gen};
    state.active.bytes += buf.length;
    state.syncer.mark(buf.length);
    return entry;
};
