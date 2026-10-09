let TABLE: number[] | null = null;

const makeTable = (): number[] => {
    const table: number[] = new Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
};

/**
 * IEEE crc32 over buf[start, end). Pure JS table-driven variant — around
 * GB/s on modern hardware, so verifying a small log record costs well under
 * a microsecond.
 */
export const crc32 = (buf: Buffer, start: number = 0, end: number = buf.length): number => {
    if (TABLE === null) {
        TABLE = makeTable();
    }
    let c = 0xffffffff;
    for (let i = start; i < end; i++) {
        c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
};
