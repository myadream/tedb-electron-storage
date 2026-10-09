import type {IEngine, IEngineOptions} from './IEngine';
import {open as openLogEngine} from '../LogEngine';

export const DEFAULT_SEG_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_HISTORY: 0 | 1 = 1;
export const DEFAULT_COMPACT_DEAD_RATIO = 0.5;
export const DEFAULT_COMPACT_MIN_DEAD_BYTES = 4 * 1024 * 1024;

export type {IEngine, IEngineOptions, IEngineValue} from './IEngine';

/**
 * Open the engine backing a collection at `collectionPath`. This is the only
 * symbol the storage driver consumes — swapping or adding engine
 * implementations happens behind this factory.
 */
export const createEngine = (collectionPath: string, options: IEngineOptions): Promise<IEngine> => {
    const resolved = {
        durability: options.durability,
        segMaxBytes: options.segMaxBytes ?? DEFAULT_SEG_MAX_BYTES,
        history: options.history ?? DEFAULT_HISTORY,
        compactDeadRatio: options.compactDeadRatio ?? DEFAULT_COMPACT_DEAD_RATIO,
        compactMinDeadBytes: options.compactMinDeadBytes ?? DEFAULT_COMPACT_MIN_DEAD_BYTES,
    };
    return openLogEngine(collectionPath, resolved);
};
