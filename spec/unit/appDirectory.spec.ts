/**
 * AppDirectory picks the on-disk data root per platform (or honours a custom
 * dir). The platform branches only ran on the host OS so far â€?mock
 * os.platform to pin each branch. Pure logic: nothing is written to disk.
 */
import {AppDirectory} from '../../src';
import * as path from 'path';

// replace only os.platform; everything else (homedir, ...) stays real
jest.mock('os', () => {
    const actual = jest.requireActual('os');
    return {...actual, platform: jest.fn(actual.platform)};
});
const osModule = require('os');
const platformMock = osModule.platform as jest.Mock;

describe('AppDirectory.userData', () => {
    const home: string = osModule.homedir();

    afterEach(() => {
        platformMock.mockRestore();
    });

    test('custom dir wins and is joined with the collection name', () => {
        const app = new AppDirectory('mydb', 'D:/data');
        expect(app.userData()).toBe(path.join('D:/data', 'mydb'));
    });

    test('null dir falls back to the platform default', () => {
        platformMock.mockReturnValue('win32');
        expect(new AppDirectory('mydb', null).userData())
            .toBe(path.join(home, 'AppData', 'Local', 'mydb'));
    });

    test('empty dir falls back to the platform default too', () => {
        platformMock.mockReturnValue('win32');
        expect(new AppDirectory('mydb', '').userData())
            .toBe(path.join(home, 'AppData', 'Local', 'mydb'));
    });

    test('darwin maps to ~/Library/Application Support/<db>', () => {
        platformMock.mockReturnValue('darwin');
        expect(new AppDirectory('mydb', null).userData())
            .toBe(path.join(home, 'Library', 'Application Support', 'mydb'));
    });

    test('win32 maps to ~/AppData/Local/<db>', () => {
        platformMock.mockReturnValue('win32');
        expect(new AppDirectory('mydb', null).userData())
            .toBe(path.join(home, 'AppData', 'Local', 'mydb'));
    });

    test('linux maps to ~/.local/share/<db>', () => {
        platformMock.mockReturnValue('linux');
        expect(new AppDirectory('mydb', null).userData())
            .toBe(path.join(home, '.local', 'share', 'mydb'));
    });

    test('unknown platforms resolve to an empty root', () => {
        platformMock.mockReturnValue('sunos' as any);
        expect(new AppDirectory('mydb', null).userData()).toBe('');
    });

    test('exposes the platform it was constructed under', () => {
        platformMock.mockReturnValue('linux');
        expect(new AppDirectory('mydb', null).platform).toBe('linux');
        expect(new AppDirectory('mydb', null).col).toBe('mydb');
    });
});
