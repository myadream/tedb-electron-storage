import {promises as fsp} from 'graceful-fs';
import {FLAG_NONE, encodeRecord} from './records';
import {IKeyEntry, ILogState, ISegment} from './state';
import {writeManifest} from './manifest';
import {createSegment, nextSegmentId} from './recover';
import {run} from './append';
import {tryReadRaw} from './read';

/** Hard cap on open segment fds — enforced by forced compaction. */
const MAX_SEGMENTS = 128;

/** Read paths call this so they never touch segments mid-compaction. */
export const waitForCompaction = (state: ILogState): Promise<unknown> => {
    // a failed compaction must not fail readers — old state stays intact
    return state.compacting ? state.compacting.catch(() => undefined) : Promise.resolve();
};

const totalBytes = (state: ILogState): number => {
    let total = 0;
    for (const s of state.segments.values()) {
        total += s.bytes;
    }
    return total;
};

const liveBytes = (state: ILogState): number => {
    let total = 0;
    for (const e of state.keydir.values()) {
        total += e.len;
    }
    for (const e of state.prevdir.values()) {
        total += e.len;
    }
    return total;
};

const needsCompaction = (state: ILogState): boolean => {
    if (state.segments.size > MAX_SEGMENTS) {
        return true;
    }
    const total = totalBytes(state);
    const dead = total - liveBytes(state);
    return total > 0 && dead >= state.opts.compactMinDeadBytes && dead / total >= state.opts.compactDeadRatio;
};

/**
 * Schedule a compaction when the thresholds say so. Runs on the write chain
 * (serialized with appends); readers wait via `waitForCompaction`.
 */
export const scheduleCompactionIfNeeded = (state: ILogState): void => {
    if (state.compacting || !needsCompaction(state)) {
        return;
    }
    state.compacting = run(state, () => compact(state)).finally(() => {
        state.compacting = null;
    });
    state.compacting.catch(() => undefined);
};

/**
 * Copy every live generation into one fresh segment (per key in ascending
 * gen order — rebuild assumes that), then swap the manifest atomically and
 * retire the old segments. Crash-safe by order: the new segment is not
 * referenced until the manifest swap, and old segments are only unlinked
 * afterwards. A failure mid-way aborts with the old state intact.
 */
const compact = async (state: ILogState): Promise<void> => {
    for (const seg of state.retired) {
        await seg.fd.close();
    }
    state.retired = [];
    const id = nextSegmentId(state);
    const target = await createSegment(state, id);
    const newKeydir = new Map<string, IKeyEntry>();
    const newPrevdir = new Map<string, IKeyEntry>();
    try {
        for (const [key, cur] of state.keydir) {
            const prev = state.prevdir.get(key);
            const curRaw = await tryReadRaw(state, cur);
            const prevRaw = prev ? await tryReadRaw(state, prev) : null;
            if (curRaw === null && prevRaw === null) {
                // both generations unusable — the repair path would drop
                // the key, so compaction drops it too
                state.keydir.delete(key);
                state.prevdir.delete(key);
                continue;
            }
            if (curRaw === null) {
                // current damaged, previous readable — promote it, the
                // same outcome getItem's repair would produce
                const written = await copyInto(target, key, prevRaw as string, prev!.gen);
                newKeydir.set(key, written);
                state.keydir.set(key, written);
                state.prevdir.delete(key);
                continue;
            }
            if (prevRaw !== null && state.opts.history >= 1 && prev) {
                const writtenPrev = await copyInto(target, key, prevRaw, prev.gen);
                newPrevdir.set(key, writtenPrev);
                state.prevdir.set(key, writtenPrev);
            } else {
                state.prevdir.delete(key);
            }
            const written = await copyInto(target, key, curRaw, cur.gen);
            newKeydir.set(key, written);
            state.keydir.set(key, written);
        }
        if (state.opts.durability === 'strict') {
            await target.fd.sync();
        }
        const oldSegments: ISegment[] = [...state.segments.values()];
        state.segments = new Map<number, ISegment>([[id, target]]);
        state.active = target;
        state.keydir = newKeydir;
        state.prevdir = newPrevdir;
        await writeManifest(state);
        // unlink first, close later: readers holding stale entries keep
        // working through the still-open handles (no EBADF window)
        for (const seg of oldSegments) {
            await fsp.rm(seg.file, {force: true});
            state.retired.push(seg);
        }
    } catch (e) {
        await target.fd.close();
        await fsp.rm(target.file, {force: true});
        throw e;
    }
};

const copyInto = async (target: ISegment, key: string, raw: string, gen: number): Promise<IKeyEntry> => {
    const buf = encodeRecord(key, raw, gen, FLAG_NONE);
    await target.fd.write(buf, 0, buf.length, target.bytes);
    const entry: IKeyEntry = {seg: target.id, off: target.bytes, len: buf.length, gen};
    target.bytes += buf.length;
    return entry;
};
