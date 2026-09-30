/**
 * Serializes asynchronous operations per key.
 *
 * Operations queued with the same key run strictly in submission order,
 * operations with different keys run in parallel. The internal chain tail
 * never rejects, so one failed operation does not block the operations
 * queued behind it, while the promise returned to the caller still
 * propagates that operation's own result or failure.
 */
export class KeyedQueue {
    private readonly chains = new Map<string, Promise<null>>();

    public enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
        const tail = this.chains.get(key) || Promise.resolve(null);
        const run = tail.then(operation, operation);
        const swallowed = run.then((): null => null, (): null => null);
        this.chains.set(key, swallowed);
        swallowed.then((): void => {
            if (this.chains.get(key) === swallowed) {
                this.chains.delete(key);
            }
        });
        return run;
    }

    /**
     * Resolves once every operation that was queued at call time has settled.
     * Used as a barrier before whole-collection actions such as clear().
     */
    public pending(): Promise<null> {
        return Promise.all(Array.from(this.chains.values())).then((): null => null);
    }
}
