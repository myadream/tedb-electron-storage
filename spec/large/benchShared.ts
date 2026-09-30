/**
 * Shared plumbing for the spec/large benchmarks: dataset shape, scale
 * control, timing and report helpers. Not a test file (no .spec suffix).
 *
 * Scale is controlled with TEDB_LARGE_N (default 3000 to keep CI sane;
 * the ~100k run is TEDB_LARGE_N=100000). Both benchmarks use the same
 * document shape so their numbers stay comparable.
 */
export const BENCH_N = process.env.TEDB_LARGE_N ? parseInt(process.env.TEDB_LARGE_N, 10) : 3000;

export const keyOf = (i: number): string => `id${i}`;

/** Initial keys are `id<i>`; keys added by the linked workload are `ida<n>`. */
export const indexOfKey = (key: string, datasetSize: number = BENCH_N): number => {
    if (key.startsWith('ida')) {
        return datasetSize + parseInt(key.slice(3), 10);
    }
    return parseInt(key.slice(2), 10);
};

export const docOf = (key: string, round = 0) => ({
    _id: key,
    index: indexOfKey(key),
    round,
    pad: 'x'.repeat(32),
});

export const range = (start: number, count: number): number[] =>
    Array.from({length: count}, (_, j) => start + j);

/** One console.log wrapper so every benchmark line needs a single lint waiver. */
export const log = (line: string): void => {
    // eslint-disable-next-line no-console
    console.log(line);
};

/** Wall-clock line for an isolated phase: total, throughput and per-op. */
export const wallLine = (name: string, ms: number, ops: number): string => {
    const perOp = ops > 0 ? (ms / ops).toFixed(2) : '-';
    const opsPerSec = ms > 0 ? Math.round((ops / ms) * 1000) : 0;
    return `${name}: ${ms}ms (${ops} ops, ${opsPerSec} op/s, ${perOp} ms/op)`;
};

export interface IClassStat {
    ops: number;
    latencySum: number;
}

export type TClassStats = Record<string, IClassStat>;

export const newClassStats = (names: string[]): TClassStats => {
    const stats: TClassStats = {};
    for (const name of names) {
        stats[name] = {ops: 0, latencySum: 0};
    }
    return stats;
};

/**
 * Time one operation and accumulate it under its class. Under concurrent
 * dispatch the per-class sum is average per-op latency, not wall time —
 * wall time is reported separately for the whole mixed phase.
 */
export const bump = (stats: TClassStats, name: string, op: () => Promise<any>): Promise<void> => {
    const t0 = Date.now();
    return op().then(() => {
        stats[name].ops += 1;
        stats[name].latencySum += Date.now() - t0;
    });
};

export const classLine = (stats: TClassStats, name: string): string => {
    const s = stats[name];
    const avg = s.ops > 0 ? (s.latencySum / s.ops).toFixed(2) : '-';
    return `${name}: ${s.ops} ops, avg ${avg} ms/op`;
};
