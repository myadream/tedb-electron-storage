/**
 * An empty index (the placeholder entry tedb keeps for an index with no keys)
 * should not be surfaced as data. Detected by parsing instead of comparing
 * serialized literals — a literal comparison breaks as soon as whitespace or
 * key order differs.
 * @param {string} index
 * @returns {boolean}
 */
export const indexCheck = (index: string): boolean => {
    try {
        const parsed = JSON.parse(index);
        if (!Array.isArray(parsed) || parsed.length !== 1) {
            return false;
        }
        const entry = parsed[0];
        return entry !== null && typeof entry === 'object'
            && entry.key === null
            && Array.isArray(entry.value)
            && entry.value.every((v: any) => v === null || v === undefined);
    } catch (e) {
        return false;
    }
};
