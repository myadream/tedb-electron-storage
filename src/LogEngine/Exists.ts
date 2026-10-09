import {ILogState} from './state';

/**
 * Raw keydir existence probe — zero IO, never revives. Corruption handling
 * lives on the read path (getItem's CRC check).
 */
export const has = (state: ILogState, key: string): boolean => state.keydir.has(key);
