import { ApiError } from './errors.js';

/**
 * Adds `req.withSlot(fn, weight)`: runs `fn(signal)` holding `weight` concurrency slots.
 * The signal aborts when the client disconnects (499) or REQUEST_TIMEOUT_MS
 * elapses (504); either way the slot is released immediately, even if the
 * work ignores the signal.
 */
export function slotMiddleware({ limiter, timeoutMs }) {
    return (req, res, next) => {
        req.withSlot = async (fn, weight = 1) => {
            const controller = new AbortController();
            const onClose = () => {
                if (!res.writableFinished) controller.abort(new ApiError(499, 'Client closed the request.', { code: 'cancelled' }));
            };
            res.on('close', onClose);
            const timer = setTimeout(() => controller.abort(new ApiError(504,
                `The model did not finish within ${Math.round(timeoutMs / 1000)}s (REQUEST_TIMEOUT_MS).`, { code: 'timeout' })), timeoutMs);
            timer.unref();
            let release;
            try {
                release = await limiter.acquire(controller.signal, weight);
                return await fn(controller.signal);
            } finally {
                clearTimeout(timer);
                res.off('close', onClose);
                release?.();
            }
        };
        next();
    };
}
