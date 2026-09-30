import {
    SafeWrite, safeReadFile, UnlinkFile, RmDir, parseJSON, stringifyJSON,
    KeyedQueue, mapPool, IO_LIMIT,
} from '../../src';
import {mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync} from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'tedb-utils-'));

describe('utils.SafeWrite (atomic write)', () => {
    let dir: string;
    beforeEach(() => {
        dir = tmp();
    });
    afterEach(() => {
        rmSync(dir, {recursive: true, force: true});
    });

    test('writes the content and leaves no temp file', async () => {
        const target = path.join(dir, 'data.db');
        await SafeWrite(target, '{"a":1}');
        expect(readFileSync(target, 'utf8')).toBe('{"a":1}');
        expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
    });

    test('atomically replaces an existing file', async () => {
        const target = path.join(dir, 'data.db');
        await SafeWrite(target, '{"a":1}');
        await SafeWrite(target, '{"a":2}');
        expect(readFileSync(target, 'utf8')).toBe('{"a":2}');
        expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
    });

    test('concurrent SafeWrites to one target never corrupt it', async () => {
        const target = path.join(dir, 'data.db');
        await Promise.all(Array.from({length: 30}, (_, i) =>
            SafeWrite(target, JSON.stringify({writer: i})),
        ));
        const final = JSON.parse(readFileSync(target, 'utf8'));
        expect(final).toHaveProperty('writer');
        expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
    });
});

describe('utils error semantics', () => {
    let dir: string;
    beforeEach(() => {
        dir = tmp();
    });
    afterEach(() => {
        rmSync(dir, {recursive: true, force: true});
    });

    test('safeReadFile resolves false only for missing files', async () => {
        await expect(safeReadFile(path.join(dir, 'missing.db'))).resolves.toBe(false);
        // reading a directory is a real error, not "missing"
        mkdirSync(path.join(dir, 'adir'));
        await expect(safeReadFile(path.join(dir, 'adir'))).rejects.toBeTruthy();
    });

    test('UnlinkFile tolerates missing files but reports other errors', async () => {
        await expect(UnlinkFile(path.join(dir, 'missing.db'))).resolves.toBeNull();
        // unlinking a directory is a real error on every platform
        mkdirSync(path.join(dir, 'adir'));
        await expect(UnlinkFile(path.join(dir, 'adir'))).rejects.toBeTruthy();
    });

    test('RmDir resolves for a missing directory', async () => {
        await expect(RmDir(path.join(dir, 'missing'))).resolves.toBeNull();
    });
});

describe('utils JSON helpers', () => {
    test('stringifyJSON passes strings through and serializes objects', async () => {
        await expect(stringifyJSON('already')).resolves.toBe('already');
        await expect(stringifyJSON({a: 1})).resolves.toBe('{"a":1}');
    });

    test('parseJSON passes objects and arrays through, parses strings', async () => {
        const obj = {a: 1};
        await expect(parseJSON(obj)).resolves.toBe(obj);
        const arr = [1, 2];
        await expect(parseJSON(arr)).resolves.toBe(arr);
        await expect(parseJSON('{"a":1}')).resolves.toEqual({a: 1});
    });
});

describe('KeyedQueue', () => {
    test('serializes operations on the same key in submission order', async () => {
        const queue = new KeyedQueue();
        const order: number[] = [];
        const slow = (n: number) => queue.enqueue('k', async (): Promise<number> => {
            await new Promise((res) => setTimeout(res, 10 - (n % 10)));
            order.push(n);
            return n;
        });
        const results = await Promise.all([slow(1), slow(2), slow(3)]);
        expect(results).toEqual([1, 2, 3]);
        expect(order).toEqual([1, 2, 3]);
    });

    test('runs operations on different keys in parallel', async () => {
        const queue = new KeyedQueue();
        let running = 0;
        let peak = 0;
        const task = (key: string) => queue.enqueue(key, async (): Promise<null> => {
            running++;
            peak = Math.max(peak, running);
            await new Promise((res) => setTimeout(res, 30));
            running--;
            return null;
        });
        await Promise.all(['a', 'b', 'c', 'd'].map(task));
        expect(peak).toBeGreaterThan(1);
    });

    test('a failed operation does not block the ones behind it', async () => {
        const queue = new KeyedQueue();
        const first = queue.enqueue('k', async (): Promise<null> => {
            throw new Error('boom');
        });
        const second = queue.enqueue('k', async () => 'ok');
        await expect(first).rejects.toThrow('boom');
        await expect(second).resolves.toBe('ok');
    });

    test('pending resolves once queued operations settle', async () => {
        const queue = new KeyedQueue();
        let done = false;
        queue.enqueue('k', async (): Promise<null> => {
            await new Promise((res) => setTimeout(res, 30));
            done = true;
            return null;
        });
        await queue.pending();
        expect(done).toBe(true);
    });
});

describe('mapPool', () => {
    test('preserves result order and respects the concurrency limit', async () => {
        let running = 0;
        let peak = 0;
        const items = Array.from({length: 50}, (_, i) => i);
        const results = await mapPool(items, 4, async (n) => {
            running++;
            peak = Math.max(peak, running);
            await new Promise((res) => setTimeout(res, 5));
            running--;
            return n * 2;
        });
        expect(results).toEqual(items.map((n) => n * 2));
        expect(peak).toBeLessThanOrEqual(4);
        expect(peak).toBeGreaterThan(1);
    });

    test('handles empty input', async () => {
        await expect(mapPool([], IO_LIMIT, async (x) => x)).resolves.toEqual([]);
    });

    test('propagates failures', async () => {
        await expect(mapPool([1, 2, 3], 2, async (n) => {
            if (n === 2) {
                throw new Error('nope');
            }
            return n;
        })).rejects.toThrow('nope');
    });
});
