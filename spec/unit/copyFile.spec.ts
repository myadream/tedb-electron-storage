import {CopyFile} from '../../src';
import {mkdtempSync, rmSync, writeFileSync, readFileSync} from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'tedb-copyfile-'));

describe('utils.CopyFile', () => {
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
        writeFileSync(src, '###not json###\x00\x01binary', 'utf8');
        await CopyFile(src, dest);
        expect(readFileSync(dest, 'utf8')).toBe(readFileSync(src, 'utf8'));
    });

    test('rejects with its prefix when the source is missing', async () => {
        await expect(CopyFile(path.join(dir, 'nope'), path.join(dir, 'dest')))
            .rejects.toThrow(':::Storage::: CopyFile Error.');
    });
});
