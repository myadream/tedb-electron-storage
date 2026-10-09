import {LogRecordError, decodeRecordAt} from './records';
import {IKeyEntry, ILogState} from './state';
import type {IEngineValue} from '../Engine/IEngine';

/** Read a record's raw payload back, or null when it fails its CRC / is gone. */
export const tryReadRaw = async (state: ILogState, entry: IKeyEntry): Promise<string | null> => {
    try {
        const seg = state.segments.get(entry.seg);
        if (!seg) {
            return null;
        }
        const buf = Buffer.alloc(entry.len);
        const {bytesRead} = await seg.fd.read(buf, 0, entry.len, entry.off);
        if (bytesRead < entry.len) {
            return null;
        }
        const rec = decodeRecordAt(buf, 0);
        return rec.value;
    } catch (e) {
        if (e instanceof LogRecordError) {
            return null;
        }
        throw e;
    }
};

/** tryReadRaw + JSON.parse — an intact record with an unparseable payload counts as damaged. */
export const tryRead = async (state: ILogState, entry: IKeyEntry): Promise<IEngineValue | undefined> => {
    const raw = await tryReadRaw(state, entry);
    if (raw === null) {
        return undefined;
    }
    try {
        return {raw, value: JSON.parse(raw)};
    } catch (e) {
        if (e instanceof SyntaxError) {
            return undefined;
        }
        throw e;
    }
};
