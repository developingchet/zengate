/** Minimal in-process counters exposed as JSON on GET /metrics. */
export function createMetrics() {
    const startedAt = Date.now();
    const byStatus = new Map();
    let requests = 0;
    let authFailures = 0;
    let rateLimited = 0;

    const middleware = (req, res, next) => {
        requests += 1;
        res.on('finish', () => {
            const key = String(res.statusCode);
            byStatus.set(key, (byStatus.get(key) || 0) + 1);
        });
        next();
    };

    return Object.freeze({
        middleware,
        authFailure: () => { authFailures += 1; },
        rateLimited: () => { rateLimited += 1; },
        snapshot: (extra = {}) => ({
            uptime_s: Math.round((Date.now() - startedAt) / 1000),
            requests,
            auth_failures: authFailures,
            rate_limited: rateLimited,
            responses_by_status: Object.fromEntries(byStatus),
            ...extra,
        }),
    });
}
