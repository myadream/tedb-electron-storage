import {CopyFile} from '../../src';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync} from 'fs';
import * as os from 'os';
import * as path from 'path';
import {setupStorage, teardownStorage, baseFile, pastFile, readRaw, corruptFile, doc, ITestContext} from '../helpers';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'tedb-copyfile-'));

describe('utils.CopyFile (backup copy semantics)', () => {
    let dir: string;
    beforeEach(() => {
        dir = tmp();
    });
    afterEach(() => {
        rmSync(dir, {recursive: true, force: true});
    });

    test('copies bytes verbatim — including content that is not parsable JSON', async () => {
        const src = path.join(dir, 'src.db');
        const dest = path.join(dir, 'dest.db');
        writeFileSync(src, '###not json###', 'utf8');
        await CopyFile(src, dest);
        expect(readFileSync(dest, 'utf8')).toBe('###not json###');
    });

    test('rejects when the source file is missing', async () => {
        await expect(CopyFile(path.join(dir, 'missing.db'), path.join(dir, 'dest.db'))).rejects.toBeTruthy();
    });

    test('rejects when the source path is a directory', async () => {
        mkdirSync(path.join(dir, 'adir'));
        await expect(CopyFile(path.join(dir, 'adir'), path.join(dir, 'dest.db'))).rejects.toBeTruthy();
    });
});

describe('setItem backup invariant', () => {
    let ctx: ITestContext;
    beforeEach(() => {
        ctx = setupStorage('invardb', 'invarcol');
    });
    afterEach(async () => {
        await teardownStorage(ctx);
    });

    test('updating a key whose base file is corrupted still preserves the previous generation in past', async () => {
        await ctx.storage.setItem('k1', doc('k1', {v: 1}));
        // external corruption of the current file between two updates
        corruptFile(baseFile(ctx, 'k1'));
        await ctx.storage.setItem('k1', doc('k1', {v: 2}));
        // past must be the exact previous generation (the corrupted bytes),
        // not silently skipped
        expect(readRaw(pastFile(ctx, 'k1'))).toBe('###corrupted###');
        expect(readRaw(baseFile(ctx, 'k1'))).toBe(JSON.stringify(doc('k1', {v: 2})));
    });
});
