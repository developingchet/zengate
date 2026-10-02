/**
 * Map with at most `limit` calls in flight, keeping results in input order.
 * The first failure calls `onFailure` and stops new calls.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @param {() => void} [onFailure]
 * @returns {Promise<R[]>}
 */
export async function mapLimited(items, limit, fn, onFailure = () => {}) {
    const results = new Array(items.length);
    let next = 0;
    let failed = false;
    const worker = async () => {
        while (next < items.length && !failed) {
            const index = next;
            next += 1;
            try {
                results[index] = await fn(items[index], index);
            } catch (error) {
                failed = true;
                onFailure();
                throw error;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
    return results;
}
