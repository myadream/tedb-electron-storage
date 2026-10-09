export type {IStorageDriverExtended, TiteratorCB, TDurability, IElectronStorageOptions} from './types';
export {ElectronStorage, indexCheck} from './StorageDriver';
export {AppDirectory} from './AppDirectory';
export type {IAppDirectory} from './AppDirectory';
export {
    TruncateFile,
    OpenFile,
    MakeDir,
    CopyFile,
    AppendFile,
    CloseFile,
    FileStat,
    FileSync,
    FlushStorage,
    WriteFile,
    ReadFile,
    SafeWrite,
    safeReadFile,
    parseJSON,
    stringifyJSON,
    EnsureDataFile,
    UnlinkFile,
    ReadDir,
    RmDir,
    LStat,
    CopyAndWrite,
    RenameFile,
    safeParse,
    safeStat,
    safeDirExists,
    KeyedQueue,
    mapPool,
    IO_LIMIT,
} from './utils';
export type {IFlushStorageOptions} from './utils/FlushStorage';
export type {IsafeReadFileOptions} from './utils/safeReadFile';
