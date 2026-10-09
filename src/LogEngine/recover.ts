import {promises as fsp} from 'graceful-fs';
import {safeReadFile} from '../utils';
import {FLAG_TOMBSTONE, LogRecordError, decodeRecordAt} from './records';
import {IKeyEntry, ILogState, ISegment, SEG_RE, segName} from './state';
import {IManifest, pidAlive, writeManifest} from './manifest';
const path = require('path');

/**
 * Startup recovery: read the manifest (or decide to rebuild), verify the
 * single-instance pid lock, scan every committed segment to rebuild
 * keydir/prevdir, truncate the active segment's torn tail, remove orphan
 * segments and rewrite the manifest under our own pid.
 */
export const recover = async (state: ILogState): Promise<void> => {
    const rawManifest = await safeReadFile(state.manifestPath);
    const manifest = parseManifest(rawManifest);
    if (manifest && typeof manifest.pid === 'number' && manifest.pid !== process.pid && pidAlive(manifest.pid)) {
        throw new Error(`:::Storage::: collectionInUse Error. another process (pid ${manifest.pid}) is actively using this collection`);
    }

    const sealedInManifest = new Set<number>(manifest ? manifest.segments.filter((s) => s.sealed).map((s) => s.id) : []);
    const knownInManifest = new Set<number>(manifest ? manifest.segments.map((s) => s.id) : []);
    let maxGen = manifest && Number.isFinite(manifest.nextGen) ? manifest.nextGen - 1 : 0;

    const names = (await fsp.readdir(state.segmentsPath)).filter((f) => SEG_RE.test(f)).sort();
    for (const name of names) {
        const id = Number(name.slice(4, 10));
        const file = path.join(state.segmentsPath, name);
        if (manifest && !knownInManifest.has(id)) {
            // orphan: created after the last manifest write (crashed roll)
            // or left behind by a failed compaction — never committed
            await fsp.rm(file, {force: true});
            continue;
        }
        const sealed = manifest ? sealedInManifest.has(id) : id !== Number(names[names.length - 1].slice(4, 10));
        maxGen = Math.max(maxGen, await scanSegment(state, id, file, sealed));
    }
    if (!state.active) {
        const id = nextSegmentId(state);
        state.active = await createSegment(state, id);
        state.segments.set(id, state.active);
    }
    state.nextGen = maxGen + 1;
    await writeManifest(state);
};

const parseManifest = (raw: string | false): IManifest | null => {
    if (raw === false) {
        return null;
    }
    try {
        return JSON.parse(raw) as IManifest;
    } catch (e) {
        // corrupt manifest: fall through to a full segment scan
        return null;
    }
};

/** Scan one segment file, rebuilding keydir/prevdir. Returns the max gen seen. */
const scanSegment = async (state: ILogState, id: number, file: string, sealed: boolean): Promise<number> => {
    const fh = await fsp.open(file, sealed ? 'r' : 'r+');
    const size = (await fh.stat()).size;
    const buf = Buffer.alloc(size);
    if (size > 0) {
        await fh.read(buf, 0, size, 0);
    }
    let off = 0;
    let maxGen = 0;
    let damaged = false;
    while (off < size) {
        let rec;
        try {
            rec = decodeRecordAt(buf, off);
        } catch (e) {
            if (e instanceof LogRecordError) {
                damaged = true;
                break;
            }
            await fh.close();
            throw e;
        }
        applyRecord(state, rec.key, rec.gen, rec.flags, id, off, rec.recordLen);
        if (rec.gen > maxGen) {
            maxGen = rec.gen;
        }
        off += rec.recordLen;
    }
    if (damaged && !sealed) {
        // torn tail of the active segment: bytes after the last complete
        // record are an unfinished append — drop them
        await fh.truncate(off);
    }
    // sealed segments keep what remains readable; damaged records surface
    // through the per-key repair path on read
    const seg: ISegment = {id, file, fd: fh, bytes: size, sealed};
    state.segments.set(id, seg);
    if (!sealed) {
        state.active = seg;
    }
    return maxGen;
};

const applyRecord = (state: ILogState, key: string, gen: number, flags: number, seg: number, off: number, len: number): void => {
    if (flags === FLAG_TOMBSTONE) {
        state.keydir.delete(key);
        state.prevdir.delete(key);
        return;
    }
    const entry: IKeyEntry = {seg, off, len, gen};
    const old = state.keydir.get(key);
    if (old && state.opts.history >= 1) {
        state.prevdir.set(key, old);
    }
    state.keydir.set(key, entry);
};

/** Lowest free segment id across live and retired segments. */
export const nextSegmentId = (state: ILogState): number => {
    let max = 0;
    for (const id of state.segments.keys()) {
        if (id > max) max = id;
    }
    for (const s of state.retired) {
        if (s.id > max) max = s.id;
    }
    return max + 1;
};

/** Create (and truncate) a fresh segment file with a writable handle. */
export const createSegment = async (state: ILogState, id: number): Promise<ISegment> => {
    const file = path.join(state.segmentsPath, segName(id));
    const fd = await fsp.open(file, 'w+');
    return {id, file, fd, bytes: 0, sealed: false};
};
