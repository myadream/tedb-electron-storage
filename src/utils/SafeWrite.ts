import {FlushStorage, IFlushStorageOptions, WriteFile, RenameFile} from './index';
import {KeyedQueue} from './KeyedQueue';
import type {TDurability} from '../types';
import {unlink} from 'graceful-fs';
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

const atomicWrite = (filename: string, data: string | Buffer | Uint8Array, durability: TDurability): Promise<null> => {
    return new Promise((resolve, reject) => {
        const tempFile = `${filename}.tmp.${process.pid}.${tempCounter++}`;
        const dirOptions: IFlushStorageOptions = {
            filename: path.dirname(filename),
            isDir: true,
        };
        const cleanupTemp = (): Promise<null> => {
            return new Promise((res) => {
                unlink(tempFile, () => res(null));
            });
        };
        return WriteFile(tempFile, data)
            .then(() => {
                if (durability === 'relaxed') {
                    // keep the atomic rename, skip both fsyncs — see TDurability
                    return null;
                }
                return FlushStorage(tempFile);
            })
            .then(() => renameWithRetry(tempFile, filename))
            .then(() => {
                if (durability === 'relaxed') {
                    return null;
                }
                return FlushStorage(dirOptions);
            })
            .then(resolve)
            .catch((err) => {
                return cleanupTemp().then((): void => {
                    reject(new Error(':::Storage::: SafeWrite Error. ' + (err.message || err)));
                });
            });
    });
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
