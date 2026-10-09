import {SafeWrite} from '../utils';
import {segName, ILogState} from './state';

export interface IManifestSegment {
    id: number;
    file: string;
    bytes: number;
    sealed: boolean;
}

export interface IManifest {
    version: number;
    engine: string;
    pid: number;
    nextGen: number;
    segments: IManifestSegment[];
    checkpoint: {segment: number; offset: number; gen: number};
}

/** Process-liveness probe for the single-instance guard. */
export const pidAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: any) {
        return e.code === 'EPERM'; // exists but owned by someone else
    }
};

/**
 * Atomically rewrite the manifest. Called on open, segment roll, compaction
 * and clear — a crash between two writes only leaves the previous manifest,
 * which still lists every committed segment.
 */
export const writeManifest = (state: ILogState): Promise<null> => {
    const manifest: IManifest = {
        version: 1,
        engine: 'log',
        pid: process.pid,
        nextGen: state.nextGen,
        segments: [...state.segments.values()].sort((a, b) => a.id - b.id).map((s) => ({id: s.id, file: segName(s.id), bytes: s.bytes, sealed: s.sealed})),
        // v1 recovers by scanning segments in full; checkpoint is recorded
        // for future prefix-skipping but not yet consulted
        checkpoint: {segment: state.active.id, offset: state.active.bytes, gen: state.nextGen - 1},
    };
    return SafeWrite(state.manifestPath, JSON.stringify(manifest), 'strict');
};
