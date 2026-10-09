import {promises as fsp} from 'graceful-fs';
import type {FileHandle} from 'fs/promises';
import {GroupSync} from './sync';
import {recover} from './recover';
import type {IEngineOptions} from '../Engine/IEngine';
const path = require('path');

export const MANIFEST_FILE = 'manifest.json';
export const SEGMENTS_DIR = 'segments';
export const SEG_RE = /^seg-\d{6}\.log$/;
export const segName = (id: number): string => `seg-${String(id).padStart(6, '0')}.log`;

export interface ISegment {
    id: number;
    file: string;
    fd: FileHandle;
    bytes: number;
    sealed: boolean;
}

/** Where a live record version lives inside the segment set. */
export interface IKeyEntry {
    seg: number;
    off: number;
    len: number;
    gen: number;
}

/** Every mutation flows through this state bag — the op files take it as their first argument. */
export interface ILogState {
    collectionPath: string;
    manifestPath: string;
    segmentsPath: string;
    opts: Required<IEngineOptions>;
    keydir: Map<string, IKeyEntry>;
    prevdir: Map<string, IKeyEntry>;
    segments: Map<number, ISegment>;
    /** Unlinked segments whose fds stay open until the next compaction (in-flight readers). */
    retired: ISegment[];
    active: ISegment;
    nextGen: number;
    /** Serializes every mutation (appends, rolls, compactions). */
    chain: Promise<unknown>;
    /** Set while a compaction runs; read paths wait on it. */
    compacting: Promise<unknown> | null;
    syncer: GroupSync;
}

/**
 * Build the state bag and recover it from disk (mkdir → recover → manifest).
 * `active`/`syncer` are filled in before recover returns.
 */
export const createState = async (collectionPath: string, opts: Required<IEngineOptions>): Promise<ILogState> => {
    const state: ILogState = {
        collectionPath,
        manifestPath: path.join(collectionPath, MANIFEST_FILE),
        segmentsPath: path.join(collectionPath, SEGMENTS_DIR),
        opts,
        keydir: new Map(),
        prevdir: new Map(),
        segments: new Map(),
        retired: [],
        active: null as unknown as ISegment,
        nextGen: 1,
        chain: Promise.resolve(),
        compacting: null,
        syncer: null as unknown as GroupSync,
    };
    state.syncer = new GroupSync(() => (state.active && !state.active.sealed ? state.active.fd : null));
    await fsp.mkdir(state.segmentsPath, {recursive: true});
    await recover(state);
    return state;
};
