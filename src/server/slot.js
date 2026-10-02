import { ApiError } from './errors.js';

/**
 * Adds `req.withSlot(fn, weight)`: runs `fn(signal, granted)` holding `weight` concurrency
 * slots; `granted` is the weight actually held, which MAX_CONCURRENT may cap.
 * The signal aborts when the client disconnects (499) or REQUEST_TIMEOUT_MS
 * elapses after the slot is granted (504); either way the slot is released
 * immediately, even if the work ignores the signal. Time spent queued is
 * bounded separately by the limiter.
 */
export function slotMiddleware({ limiter, timeoutMs }) {
    return (req, res, next) => {
        req.withSlot = async (fn, weight = 1) => {
            const controller = new AbortController();
            const onClose = () => {
                if (!res.writableFinished) controller.abort(new ApiError(499, 'Client closed the request.', { code: 'cancelled' }));
            };
            res.on('close', onClose);
            let timer = null;
            let release;
            try {
                release = await limiter.acquire(controller.signal, weight);
                timer = setTimeout(() => controller.abort(new ApiError(504,
                    `The model did not finish within ${Math.round(timeoutMs / 1000)}s (REQUEST_TIMEOUT_MS).`, { code: 'timeout' })), timeoutMs);
                timer.unref();
                return await fn(controller.signal, release.weight ?? weight);
            } finally {
                clearTimeout(timer);
                res.off('close', onClose);
                release?.();
                // Work started under this slot (such as sibling choices after one
                // failed) must not outlive it.
                if (!controller.signal.aborted) controller.abort(new ApiError(499, 'The request has finished.', { code: 'cancelled' }));
            }
        };
        next();
    };
}
