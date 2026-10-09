import {crc32} from './crc32';

/**
 * Log record layout (little endian), 19-byte fixed header:
 *
 *   0  4  crc32      over bytes [4, recordLen)
 *   4  8  gen        generation counter (monotonic per collection)
 *   12 2  keyLen     utf8 byte length of the key
 *   14 4  valueLen   utf8 byte length of the value (0 for tombstones)
 *   18 1  flags      0x01 = tombstone
 *   19 .. key bytes
 *      .. value bytes
 */
export const HEADER_SIZE = 19;
export const FLAG_NONE = 0;
export const FLAG_TOMBSTONE = 1;

/**
 * Thrown when bytes at an offset are not a complete, intact record — a torn
 * tail (crash mid-append) or external corruption. The engine treats only this
 * class as "damaged"; anything else propagates as a real error.
 */
export class LogRecordError extends Error {
    constructor(reason: string) {
        super(':::Storage::: logRecord damaged. ' + reason);
        this.name = 'LogRecordError';
    }
}

export interface IDecodedRecord {
    gen: number;
    key: string;
    value: string;
    flags: number;
    recordLen: number;
}

export const encodeRecord = (key: string, value: string, gen: number, flags: number = FLAG_NONE): Buffer => {
    const keyBuf = Buffer.from(key, 'utf8');
    if (keyBuf.length > 0xffff) {
        throw new Error(':::Storage::: keyTooLarge Error. key exceeds 65535 utf8 bytes');
    }
    const valueBuf = flags === FLAG_TOMBSTONE ? Buffer.alloc(0) : Buffer.from(value, 'utf8');
    const buf = Buffer.allocUnsafe(HEADER_SIZE + keyBuf.length + valueBuf.length);
    buf.writeUInt32LE(0, 0); // crc placeholder, filled below
    buf.writeBigInt64LE(BigInt(gen), 4);
    buf.writeUInt16LE(keyBuf.length, 12);
    buf.writeUInt32LE(valueBuf.length, 14);
    buf.writeUInt8(flags, 18);
    keyBuf.copy(buf, HEADER_SIZE);
    valueBuf.copy(buf, HEADER_SIZE + keyBuf.length);
    buf.writeUInt32LE(crc32(buf, 4), 0);
    return buf;
};

/**
 * Decode the record starting at `off`. Throws LogRecordError for a torn or
 * corrupted record; never reads past `buf.length`.
 */
export const decodeRecordAt = (buf: Buffer, off: number): IDecodedRecord => {
    if (buf.length - off < HEADER_SIZE) {
        throw new LogRecordError('short header');
    }
    const storedCrc = buf.readUInt32LE(off);
    const gen = Number(buf.readBigInt64LE(off + 4));
    const keyLen = buf.readUInt16LE(off + 12);
    const valueLen = buf.readUInt32LE(off + 14);
    const flags = buf.readUInt8(off + 18);
    if (gen < 0) {
        throw new LogRecordError('negative generation');
    }
    const recordLen = HEADER_SIZE + keyLen + valueLen;
    if (buf.length - off < recordLen) {
        throw new LogRecordError('short body');
    }
    if (crc32(buf, off + 4, off + recordLen) !== storedCrc) {
        throw new LogRecordError('crc mismatch');
    }
    const keyStart = off + HEADER_SIZE;
    const key = buf.toString('utf8', keyStart, keyStart + keyLen);
    const value = flags === FLAG_TOMBSTONE ? '' : buf.toString('utf8', keyStart + keyLen, off + recordLen);
    return {gen, key, value, flags, recordLen};
};
