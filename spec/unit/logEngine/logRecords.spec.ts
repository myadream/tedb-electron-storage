import {crc32} from '../../../src/LogEngine/crc32';
import {
    FLAG_NONE, FLAG_TOMBSTONE, HEADER_SIZE, LogRecordError,
    decodeRecordAt, encodeRecord,
} from '../../../src/LogEngine/records';

describe('log engine — crc32', () => {
    test('matches the IEEE check vectors', () => {
        expect(crc32(Buffer.from('123456789', 'utf8'))).toBe(0xcbf43926);
        expect(crc32(Buffer.alloc(0))).toBe(0);
    });

    test('range variant equals whole-buffer variant', () => {
        const buf = Buffer.from('hello log world', 'utf8');
        expect(crc32(buf, 6)).toBe(crc32(buf.subarray(6)));
        expect(crc32(buf, 0, 5)).toBe(crc32(buf.subarray(0, 5)));
    });
});

describe('log engine — record encoding', () => {
    test('round-trips key/value/gen/flags including unicode', () => {
        const key = '单词-書-📝';
        const value = JSON.stringify({_id: key, n: 1, tags: ['a', 'b']});
        const buf = encodeRecord(key, value, 42);
        const rec = decodeRecordAt(buf, 0);
        expect(rec.key).toBe(key);
        expect(rec.value).toBe(value);
        expect(rec.gen).toBe(42);
        expect(rec.flags).toBe(FLAG_NONE);
        expect(rec.recordLen).toBe(buf.length);
        expect(buf.length).toBeGreaterThanOrEqual(HEADER_SIZE);
    });

    test('round-trips very large generations (2^40)', () => {
        const rec = decodeRecordAt(encodeRecord('k', '{}', 2 ** 40), 0);
        expect(rec.gen).toBe(2 ** 40);
    });

    test('tombstones carry no value bytes', () => {
        const buf = encodeRecord('gone', 'ignored', 7, FLAG_TOMBSTONE);
        const rec = decodeRecordAt(buf, 0);
        expect(rec.flags).toBe(FLAG_TOMBSTONE);
        expect(rec.value).toBe('');
        expect(buf.length).toBe(HEADER_SIZE + Buffer.byteLength('gone'));
    });

    test('decodes a record at a non-zero offset', () => {
        const first = encodeRecord('a', '"1"', 1);
        const second = encodeRecord('b', '"2"', 2);
        const joined = Buffer.concat([first, second]);
        const rec = decodeRecordAt(joined, first.length);
        expect(rec.key).toBe('b');
    });

    test('rejects keys over 65535 utf8 bytes', () => {
        expect(() => encodeRecord('k'.repeat(70000), 'x', 1)).toThrow(':::Storage::: keyTooLarge Error.');
    });

    describe('damage detection (LogRecordError)', () => {
        const good = encodeRecord('k1', '{"a":1}', 9);

        test('short header', () => {
            expect(() => decodeRecordAt(good.subarray(0, 10), 0)).toThrow(LogRecordError);
        });

        test('short body (truncated tail)', () => {
            expect(() => decodeRecordAt(good.subarray(0, good.length - 3), 0)).toThrow(LogRecordError);
        });

        test('crc mismatch on a flipped payload byte', () => {
            const broken = Buffer.from(good);
            broken[broken.length - 1] ^= 0xff;
            expect(() => decodeRecordAt(broken, 0)).toThrow(LogRecordError);
        });

        test('crc mismatch on a flipped header byte', () => {
            const broken = Buffer.from(good);
            broken[6] ^= 0xff; // inside the gen field
            expect(() => decodeRecordAt(broken, 0)).toThrow(LogRecordError);
        });

        test('negative generation', () => {
            const broken = Buffer.from(good);
            broken.writeBigInt64LE(BigInt(-5), 4);
            expect(() => decodeRecordAt(broken, 0)).toThrow(LogRecordError);
        });

        test('is an Error subclass', () => {
            expect(new LogRecordError('x')).toBeInstanceOf(Error);
        });
    });
});
