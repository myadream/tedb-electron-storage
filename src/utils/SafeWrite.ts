import {FlushStorage, IFlushStorageOptions, RenameFile} from './index';
import {KeyedQueue} from './KeyedQueue';
import type {TDurability} from '../types';
import {close, promises as fsp, unlink} from 'graceful-fs';
const path = require('path');

let tempCounter = 0;

/**
 * Serializes writes per target path. Concurrent renames over the same file
 * fail outright with EPERM on Windows, so writers targeting one file line up
 * here instead of racing; writers to different files stay fully parallel.
 */
const writeQueues = new KeyedQueue();

/**
 * Windows (and antivirus software) can transiently report EPERM/EACCES/EBUSY
 * when renaming over an existing file — for example while a scanner holds a
 * freshly created file. Retry with exponential backoff (25ms..~800ms) before
 * surfacing the error.
 */
const renameWithRetry = (from: string, to: string, attempts: number = 6, delay: number = 25): Promise<null> => {
    return RenameFile(from, to).catch((err: any) => {
        const retryable = err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY');
        if (retryable && attempts > 1) {
            return new Promise((res) => setTimeout(res, delay)).then(() => renameWithRetry(from, to, attempts - 1, delay * 2));
        }
        throw err;
    });
};

const atomicWrite = async (filename: string, data: string | Buffer | Uint8Array, durability: TDurability): Promise<null> => {
    const tempFile = `${filename}.tmp.${process.pid}.${tempCounter++}`;
    let fd: number | null = null;
    try {
        // one open serves write + fsync + close: the old flow reopened the
        // temp file through FlushStorage just to fsync it
        const handle = await fsp.open(tempFile, 'w', 0o666);
        fd = handle.fd;
        if (typeof data === 'string') {
            await handle.write(data);
        } else {
            await handle.write(data as Buffer);
        }
        if (durability === 'strict') {
            await handle.sync();
        }
        await handle.close();
        fd = null;
        await renameWithRetry(tempFile, filename);
        if (durability === 'relaxed') {
            // keep the atomic rename, skip the fsyncs — see TDurability
            return null;
        }
        return await FlushStorage({filename: path.dirname(filename), isDir: true} as IFlushStorageOptions);
    } catch (err: any) {
        if (fd !== null) {
            // best effort: the handle may already be closed if close() itself failed
            await new Promise<void>((res) => close(fd as number, () => res()));
        }
        // leftover temp files never end in ".db", so scans ignore them —
        // still, don't litter: remove our own
        await new Promise<void>((res) => unlink(tempFile, () => res()));
        throw new Error(':::Storage::: SafeWrite Error. ' + (err.message || err));
    }
};

/**
 * Crash-safe file write: the data is written to a uniquely named sibling temp
 * file, flushed to disk, then atomically renamed over the target. A crash or
 * power loss mid-write can only leave behind a stale temp file — readers never
 * observe a truncated or empty data file, which is what the old truncate-and-
 * write approach could produce. Temp file names never end in ".db" so
 * collection scans ignore any leftovers.
 *
 * `durability: 'relaxed'` skips the fsyncs (file + directory) while keeping
 * the atomic rename: writes stay tear-free but a power loss may drop the most
 * recent ones.
 */
export const SafeWrite = (filename: string, data: string | Buffer | Uint8Array, durability: TDurability = 'strict'): Promise<null> => {
    return writeQueues.enqueue(filename, () => atomicWrite(filename, data, durability));
};
