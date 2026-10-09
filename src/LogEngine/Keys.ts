import {ILogState} from './state';

/** Every live key in insertion order — pure keydir, no disk scan. */
export const keys = (state: ILogState): string[] => [...state.keydir.keys()];
