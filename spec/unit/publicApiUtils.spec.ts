/**
 * Direct unit tests for the utility layer exported from the package root.
 * These helpers are public API (consumers import them from the package) but
 * the storage driver only uses a subset internally — the rest went untested.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    AppendFile, ReadFile, WriteFile, FileStat, TruncateFile, safeStat,
    EnsureDataFile, WriteNewPastandBase, safeParse, parseJSON, CopyAndWrite,
    removeBackup, MakeDir, MakeVersionDirPast, FlushStorage, SafeWrite,
    CloseFile, FileSync, LStat, OpenFile, safeReadFile,
} from '../../src';

const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'tedb-utils-'));

describe('public utils — raw file operations', () => {
    let dir: string;
    beforeEach(() => {
        dir = tmpDir();
    });
    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    describe('AppendFile', () => {
        test('creates the file on first append and accumulates after that', async () => {
            const f = path.join(dir, 'log');
            await AppendFile(f, 'a');
            await AppendFile(f, 'b');
            expect(fs.readFileSync(f, 'utf8')).toBe('ab');
        });

        test('honours an explicit options object', async () => {
            const f = path.join(dir, 'log');
            await AppendFile(f, 'x', {encoding: 'utf8', flag: 'a'});
            expect(fs.readFileSync(f, 'utf8')).toBe('x');
        });

        test('wraps errors with the AppendFile prefix', async () => {
            // appending onto a directory fails on every platform
            await expect(AppendFile(dir, 'x')).rejects.toThrow(':::Storage::: AppendFile Error.');
        });
    });

    describe('ReadFile', () => {
        test('reads utf8 by default and with explicit options', async () => {
            const f = path.join(dir, 'f');
            fs.writeFileSync(f, 'hello', 'utf8');
            await expect(ReadFile(f, null as any)).resolves.toBe('hello');
            await expect(ReadFile(f, null as any, {encoding: 'utf8'})).resolves.toBe('hello');
        });

        test('rejects with the ReadFile prefix for a missing file', async () => {
            await expect(ReadFile(path.join(dir, 'nope'), null as any))
                .rejects.toThrow(':::Storage::: ReadFile Error.');
        });
    });

    describe('WriteFile', () => {
        test('applies defaults when options are partial', async () => {
            const f = path.join(dir, 'f');
            await WriteFile(f, 'one');
            await WriteFile(f, 'two', {encoding: 'utf8'}); // mode + flag fall back
            expect(fs.readFileSync(f, 'utf8')).toBe('two');
        });

        test('wraps write errors', async () => {
            await expect(WriteFile(path.join(dir, 'missing', 'f'), 'x'))
                .rejects.toThrow(':::Storage::: WriteFile Error.');
        });
    });

    describe('FileStat / TruncateFile', () => {
        test('FileStat resolves Stats for an open fd', async () => {
            const f = path.join(dir, 'f');
            fs.writeFileSync(f, '12345', 'utf8');
            const fd = fs.openSync(f, 'r+');
            try {
                const stats = await FileStat(fd);
                expect(stats.size).toBe(5);
            } finally {
                fs.closeSync(fd);
            }
        });

        test('TruncateFile shrinks the file behind the fd', async () => {
            const f = path.join(dir, 'f');
            fs.writeFileSync(f, '12345', 'utf8');
            const fd = fs.openSync(f, 'r+');
            await TruncateFile(fd, 2);
            fs.closeSync(fd);
            expect(fs.readFileSync(f, 'utf8')).toBe('12');
        });

        test('reject with their prefixes for a stale (closed) fd', async () => {
            const fd = fs.openSync(path.join(dir, 'f'), 'w');
            fs.closeSync(fd);
            await expect(FileStat(fd)).rejects.toThrow(':::Storage::: FileStat Error.');
            await expect(TruncateFile(fd, 0)).rejects.toThrow(':::Storage::: TruncateFile Error.');
        });
    });

    describe('CloseFile / FileSync / LStat / OpenFile', () => {
        test('CloseFile and FileSync reject for a stale (closed) fd', async () => {
            const fd = fs.openSync(path.join(dir, 'f'), 'w');
            fs.closeSync(fd);
            await expect(CloseFile(fd)).rejects.toThrow(':::Storage::: CloseFile Error.');
            await expect(FileSync(fd)).rejects.toThrow(':::Storage::: FileSync Error.');
        });

        test('LStat resolves stats and rejects with a prefix for missing paths', async () => {
            const f = path.join(dir, 'f');
            fs.writeFileSync(f, 'x', 'utf8');
            await expect(LStat(f)).resolves.toMatchObject({size: 1});
            await expect(LStat(path.join(dir, 'nope'))).rejects.toThrow(':::Storage::: LStat Error.');
        });

        test('OpenFile resolves false instead of rejecting on failure', async () => {
            await expect(OpenFile(path.join(dir, 'nope'), 'r')).resolves.toBe(false);
        });
    });

    describe('safeStat', () => {
        test('resolves Stats for an existing path', async () => {
            const stats = await safeStat(dir);
            expect((stats as fs.Stats).isDirectory()).toBe(true);
        });

        test('resolves false for a missing path', async () => {
            await expect(safeStat(path.join(dir, 'nope'))).resolves.toBe(false);
        });

        test('rejects on a synchronous throw (invalid path type)', async () => {
            await expect(safeStat(null as any)).rejects.toBeTruthy();
        });
    });

    describe('MakeDir', () => {
        test('creates a directory and wraps EEXIST with its prefix', async () => {
            const d = path.join(dir, 'a');
            await MakeDir(d);
            expect(fs.existsSync(d)).toBe(true);
            await expect(MakeDir(d)).rejects.toThrow(':::Storage::: MakeDir Error.');
        });
    });
});

describe('public utils — composite helpers', () => {
    let dir: string;
    beforeEach(() => {
        dir = tmpDir();
    });
    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true});
    });

    describe('EnsureDataFile', () => {
        test('creates a missing file as empty', async () => {
            const f = path.join(dir, 'data');
            await EnsureDataFile(f);
            expect(fs.readFileSync(f, 'utf8')).toBe('');
        });

        test('keeps the content of an existing file', async () => {
            const f = path.join(dir, 'data');
            fs.writeFileSync(f, 'keep', 'utf8');
            await EnsureDataFile(f);
            expect(fs.readFileSync(f, 'utf8')).toBe('keep');
        });
    });

    describe('WriteNewPastandBase', () => {
        test('writes the same payload to past and base', async () => {
            const sub = path.join(dir, 'states', 'k1');
            fs.mkdirSync(sub, {recursive: true});
            const base = path.join(dir, 'k1.db');
            await WriteNewPastandBase(sub, null, base, '{"a":1}');
            expect(fs.readFileSync(path.join(sub, 'past'), 'utf8')).toBe('{"a":1}');
            expect(fs.readFileSync(base, 'utf8')).toBe('{"a":1}');
        });

        test('wraps failures with its prefix', async () => {
            // base location sits inside a directory that does not exist
            await expect(
                WriteNewPastandBase(dir, null, path.join(dir, 'missing', 'k1.db'), '{}'),
            ).rejects.toThrow(':::Storage::: WriteNewPastandBase Error.');
        });
    });

    describe('MakeVersionDirPast', () => {
        test('creates the directory then hands the payload to returnMany', async () => {
            const sub = path.join(dir, 'states', 'k1');
            fs.mkdirSync(path.join(dir, 'states')); // MakeDir is not recursive
            const seen: string[] = [];
            await MakeVersionDirPast(sub, (data: string) => {
                seen.push(data);
                return Promise.resolve(null);
            }, 'payload');
            expect(fs.existsSync(sub)).toBe(true);
            expect(seen).toEqual(['payload']);
        });

        test('wraps MakeDir failures with its prefix', async () => {
            await expect(
                MakeVersionDirPast(path.join(dir, 'missing', 'k1'), () => Promise.resolve(null), 'x'),
            ).rejects.toThrow(':::Storage::: MakeVersionDirPast Error.');
        });
    });

    describe('CopyAndWrite', () => {
        test('copies src to dest then overwrites src with the new data', async () => {
            const src = path.join(dir, 'src');
            const dest = path.join(dir, 'dest');
            fs.writeFileSync(src, 'old', 'utf8');
            await CopyAndWrite(src, dest, 'new');
            expect(fs.readFileSync(dest, 'utf8')).toBe('old');
            expect(fs.readFileSync(src, 'utf8')).toBe('new');
        });

        test('wraps failures with its prefix', async () => {
            await expect(CopyAndWrite(path.join(dir, 'nope'), path.join(dir, 'dest'), 'x'))
                .rejects.toThrow(':::Storage::: CopyAndWrite Error.');
        });
    });

    describe('removeBackup', () => {
        test('is a no-op for a missing directory', async () => {
            await expect(removeBackup(path.join(dir, 'nope'))).resolves.toBeNull();
        });

        test('removes dir and past file together', async () => {
            const d = path.join(dir, 'k1');
            fs.mkdirSync(d);
            fs.writeFileSync(path.join(d, 'past'), '{}', 'utf8');
            await removeBackup(d);
            expect(fs.existsSync(d)).toBe(false);
        });

        test('removes the directory when the past file is already gone', async () => {
            const d = path.join(dir, 'k1');
            fs.mkdirSync(d);
            await removeBackup(d);
            expect(fs.existsSync(d)).toBe(false);
        });

        test('wraps failures with its prefix (non-empty dir keeps RmDir failing)', async () => {
            const d = path.join(dir, 'k1');
            fs.mkdirSync(d);
            fs.writeFileSync(path.join(d, 'past'), '{}', 'utf8');
            fs.writeFileSync(path.join(d, 'stray'), 'x', 'utf8');
            await expect(removeBackup(d)).rejects.toThrow(':::Storage::: removeBackup Error.');
        });
    });

    describe('FlushStorage', () => {
        test('fsyncs an openable file', async () => {
            const f = path.join(dir, 'f');
            fs.writeFileSync(f, 'x', 'utf8');
            await expect(FlushStorage(f)).resolves.toBeNull();
        });

        test('resolves null when the file cannot be opened (fd === false)', async () => {
            await expect(FlushStorage(path.join(dir, 'nope'))).resolves.toBeNull();
        });
    });

    describe('caller-provided options are respected (regression)', () => {
        // the old option merge filled defaults but dropped the caller's own
        // values, so ReadFile(f, null, {encoding: 'utf8'}) returned a Buffer
        test('safeReadFile keeps an explicitly passed encoding', async () => {
            const f = path.join(dir, 'f');
            fs.writeFileSync(f, 'hello', 'utf8');
            await expect(safeReadFile(f, {encoding: 'utf8'})).resolves.toBe('hello');
            await expect(safeReadFile(f, {flag: 'r'})).resolves.toBe('hello');
        });

        test('ReadFile keeps an explicitly passed encoding', async () => {
            const f = path.join(dir, 'f');
            fs.writeFileSync(f, 'hello', 'utf8');
            await expect(ReadFile(f, null as any, {encoding: 'utf8'})).resolves.toBe('hello');
        });
    });

    describe('SafeWrite failure path', () => {
        test('cleans up its temp file and rejects with the SafeWrite prefix', async () => {
            await expect(SafeWrite(path.join(dir, 'missing', 'f.db'), 'x'))
                .rejects.toThrow(':::Storage::: SafeWrite Error.');
            expect(fs.readdirSync(dir)).toEqual([]); // temp file never created there
        });
    });
});

describe('public utils — JSON helpers', () => {
    test('safeParse restores Buffer-shaped payloads', async () => {
        const restored = await safeParse('{"type":"Buffer","data":[104,105]}');
        expect(restored.type).toBe('Buffer');
        expect(restored.data).toEqual([104, 105]);
    });

    test('safeParse passes plain objects through and resolves false for junk', async () => {
        await expect(safeParse('{"a":1}')).resolves.toEqual({a: 1});
        await expect(safeParse('###')).resolves.toBe(false);
        await expect(safeParse('')).resolves.toBe(false);
    });

    test('parseJSON passes objects and arrays through without re-parsing', async () => {
        const obj = {a: 1};
        const arr = [1, 2];
        await expect(parseJSON(obj)).resolves.toBe(obj);
        await expect(parseJSON(arr)).resolves.toBe(arr);
        await expect(parseJSON('{"a":1}')).resolves.toEqual({a: 1});
    });

    test('parseJSON rejects junk strings with its prefix', async () => {
        await expect(parseJSON('###')).rejects.toThrow(':::Storage::: parseJSON Error.');
    });
});
