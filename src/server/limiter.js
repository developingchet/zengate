import { ApiError } from './errors.js';

const busy = (message) => new ApiError(429, message, { code: 'server_busy', retryAfter: 2 });

/**
 * Concurrency gate with a bounded FIFO queue.
 *
 * `acquire(signal, weight)` resolves to a release function once `weight`
 * slots are free (a request with n choices runs n generations, so it costs
 * n slots). The slots are released exactly once: when the caller calls
 * release, or when `signal` aborts (timeout or client disconnect), so work
 * that ignores cancellation can never hold a slot forever. A request that
 * waits longer than `queueTimeoutMs` gets a 429, well before a proxy in
 * front would give up on a response that has not started.
 * @param {{ maxConcurrent: number, maxQueue: number, queueTimeoutMs?: number }} options
 */
export function createLimiter({ maxConcurrent, maxQueue, queueTimeoutMs = 0 }) {
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
        return Object.assign(release, { weight });
    };

    const abortedError = () => new ApiError(499, 'Request cancelled.', { code: 'cancelled' });

    function acquire(signal, requested = 1) {
        const weight = Math.min(Math.max(1, Math.floor(requested) || 1), maxConcurrent);
        if (signal?.aborted) return Promise.reject(abortedError());
        if (waiting.length === 0 && fits(weight)) {
            active += weight;
            return Promise.resolve(makeRelease(signal, weight));
        }
        if (waiting.length >= maxQueue) return Promise.reject(busy('Gateway is busy; retry shortly.'));
        return new Promise((resolve, reject) => {
            let timer = null;
            const entry = {
                weight,
                grant() {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', onAbort);
                    active += weight;
                    resolve(makeRelease(signal, weight));
                },
            };
            const leave = (error) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                const index = waiting.indexOf(entry);
                if (index >= 0) waiting.splice(index, 1);
                reject(error);
                pump();
            };
            const onAbort = () => leave(abortedError());
            if (queueTimeoutMs > 0) {
                const seconds = Math.round(queueTimeoutMs / 1000);
                timer = setTimeout(() => leave(busy(`Gateway is busy; no slot freed up within ${seconds}s (QUEUE_TIMEOUT_MS).`)), queueTimeoutMs);
                timer.unref();
            }
            signal?.addEventListener('abort', onAbort, { once: true });
            waiting.push(entry);
        });
    }

    return Object.freeze({
        acquire,
        stats: () => ({ active, queued: waiting.length, maxConcurrent, maxQueue }),
    });
}

/**
 * Caps the requests that are reading a body, queued or running. Bodies are
 * parsed before a request reaches the queue, so without this cap many large
 * uploads at once could hold far more memory than MAX_QUEUE implies.
 * @param {{ limit: number }} options
 */
export function admissionMiddleware({ limit }) {
    let admitted = 0;
    const middleware = (req, res, next) => {
        if (req.method !== 'POST') return next();
        if (admitted >= limit) return next(busy('Gateway is busy; retry shortly.'));
        admitted += 1;
        res.once('close', () => { admitted -= 1; });
        return next();
    };
    middleware.count = () => admitted;
    return middleware;
}
