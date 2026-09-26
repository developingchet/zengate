import { ApiError } from './errors.js';

/**
 * Concurrency gate with a bounded FIFO queue.
 *
 * `acquire(signal, weight)` resolves to a release function once `weight`
 * slots are free (a request with n choices runs n generations, so it costs
 * n slots). The slots are released exactly once: when the caller calls
 * release, or when `signal` aborts (timeout or client disconnect), so work
 * that ignores cancellation can never hold a slot forever.
 * @param {{ maxConcurrent: number, maxQueue: number }} options
 */
export function createLimiter({ maxConcurrent, maxQueue }) {
    let active = 0;
    const waiting = [];

    const fits = (weight) => active + weight <= maxConcurrent;

    const pump = () => {
        while (waiting.length > 0 && fits(waiting[0].weight)) waiting.shift().grant();
    };

    const makeRelease = (signal, weight) => {
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            signal?.removeEventListener('abort', release);
            active -= weight;
            pump();
        };
        signal?.addEventListener('abort', release, { once: true });
        return release;
    };

    const abortedError = () => new ApiError(499, 'Request cancelled.', { code: 'cancelled' });

    function acquire(signal, requested = 1) {
        const weight = Math.min(Math.max(1, Math.floor(requested) || 1), maxConcurrent);
        if (signal?.aborted) return Promise.reject(abortedError());
        if (waiting.length === 0 && fits(weight)) {
            active += weight;
            return Promise.resolve(makeRelease(signal, weight));
        }
        if (waiting.length >= maxQueue) {
            return Promise.reject(new ApiError(429, 'Gateway is busy; retry shortly.', { code: 'server_busy', retryAfter: 2 }));
        }
        return new Promise((resolve, reject) => {
            const entry = {
                weight,
                grant() {
                    signal?.removeEventListener('abort', onAbort);
                    active += weight;
                    resolve(makeRelease(signal, weight));
                },
            };
            const onAbort = () => {
                const index = waiting.indexOf(entry);
                if (index >= 0) waiting.splice(index, 1);
                reject(abortedError());
                pump();
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            waiting.push(entry);
        });
    }

    return Object.freeze({
        acquire,
        stats: () => ({ active, queued: waiting.length, maxConcurrent, maxQueue }),
    });
}
