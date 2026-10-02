const BUCKETS_S = Object.freeze([0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300]);
const MAX_LABELLED_PATH = 512;
const KNOWN_ROUTES = new Set(['/chat/completions', '/completions', '/responses', '/models', '/embeddings', '/metrics', '/health', '/ready']);

/** A bounded route label: known paths, ids replaced, everything else "other". */
export function routeLabel(originalUrl) {
    const raw = String(originalUrl || '').split('?')[0];
    if (raw.length > MAX_LABELLED_PATH) return 'other';
    let end = raw.length;
    while (end > 1 && raw[end - 1] === '/') end -= 1;
    const path = raw.slice(0, end).replace(/^\/v1(?=\/)/, '');
    if (KNOWN_ROUTES.has(path)) return path;
    if (/^\/responses\/[^/]+$/.test(path)) return '/responses/{id}';
    if (path.startsWith('/models/')) return '/models/{id}';
    return 'other';
}

function createHistogram() {
    const series = new Map();
    return {
        observe(label, seconds) {
            let entry = series.get(label);
            if (!entry) {
                entry = { counts: new Array(BUCKETS_S.length).fill(0), count: 0, sum: 0 };
                series.set(label, entry);
            }
            const index = BUCKETS_S.findIndex((bound) => seconds <= bound);
            if (index >= 0) entry.counts[index] += 1;
            entry.count += 1;
            entry.sum += seconds;
        },
        series,
    };
}

const escapeLabel = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

const metricHeader = (name, type, help) => [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];

function histogramLines(name, help, histogram) {
    const lines = metricHeader(name, 'histogram', help);
    for (const [route, entry] of histogram.series) {
        const label = `route="${escapeLabel(route)}"`;
        let cumulative = 0;
        BUCKETS_S.forEach((bound, index) => {
            cumulative += entry.counts[index];
            lines.push(`${name}_bucket{${label},le="${bound}"} ${cumulative}`);
        });
        lines.push(`${name}_bucket{${label},le="+Inf"} ${entry.count}`, `${name}_sum{${label}} ${entry.sum}`, `${name}_count{${label}} ${entry.count}`);
    }
    return lines;
}

const summary = (histogram) => Object.fromEntries([...histogram.series].map(([route, { count, sum }]) => [
    route, { count, mean_ms: count ? Math.round((sum / count) * 1000) : 0 },
]));

/**
 * In-process counters and latency histograms, served on GET /metrics as JSON
 * or in the Prometheus text format.
 */
export function createMetrics() {
    const startedAt = Date.now();
    const byStatus = new Map();
    const duration = createHistogram();
    const firstToken = createHistogram();
    let requests = 0;
    let authFailures = 0;
    let rateLimited = 0;

    const middleware = (req, res, next) => {
        requests += 1;
        const started = performance.now();
        const route = routeLabel(req.originalUrl ?? req.url);
        let tokenSeen = false;
        /** Record the time to the first generated token; only the first call counts. */
        req.markFirstToken = () => {
            if (tokenSeen) return;
            tokenSeen = true;
            firstToken.observe(route, (performance.now() - started) / 1000);
        };
        // 'close' also fires when the client goes away first; count those as 499, as nginx does.
        res.on('close', () => {
            const key = res.writableFinished ? String(res.statusCode) : '499';
            byStatus.set(key, (byStatus.get(key) || 0) + 1);
            duration.observe(route, (performance.now() - started) / 1000);
        });
        next();
    };

    const snapshot = (extra = {}) => ({
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        requests,
        auth_failures: authFailures,
        rate_limited: rateLimited,
        responses_by_status: Object.fromEntries(byStatus),
        latency: summary(duration),
        time_to_first_token: summary(firstToken),
        ...extra,
    });

    /**
     * @param {{ slots: object, storedResponses: number, backendReady: boolean, eventsConnected: boolean,
     *           toolRejections: number, opencode: string|null }} gauges
     */
    function prometheus(gauges) {
        const lines = [
            ...metricHeader('zengate_up_seconds', 'gauge', 'Seconds since the gateway started.'),
            `zengate_up_seconds ${Math.round((Date.now() - startedAt) / 1000)}`,
            ...metricHeader('zengate_http_responses_total', 'counter', 'Responses by HTTP status.'),
            ...[...byStatus].map(([status, count]) => `zengate_http_responses_total{status="${status}"} ${count}`),
            ...metricHeader('zengate_auth_failures_total', 'counter', 'Requests rejected for a missing or wrong API key.'),
            `zengate_auth_failures_total ${authFailures}`,
            ...metricHeader('zengate_rate_limited_total', 'counter', 'Requests rejected by the client rate limit.'),
            `zengate_rate_limited_total ${rateLimited}`,
            ...metricHeader('zengate_tool_rejections_total', 'counter', 'OpenCode tool calls rejected; each costs the model an extra round trip.'),
            `zengate_tool_rejections_total ${gauges.toolRejections}`,
            ...metricHeader('zengate_slots', 'gauge', 'Concurrency slots and queue.'),
            ...['active', 'queued', 'admitted', 'maxConcurrent', 'maxQueue'].map((key) => `zengate_slots{state="${key}"} ${gauges.slots[key]}`),
            ...metricHeader('zengate_stored_responses', 'gauge', 'Responses kept for previous_response_id.'),
            `zengate_stored_responses ${gauges.storedResponses}`,
            ...metricHeader('zengate_backend_ready', 'gauge', 'Whether OpenCode is healthy (1) or not (0).'),
            `zengate_backend_ready{opencode="${escapeLabel(gauges.opencode ?? 'unknown')}"} ${gauges.backendReady ? 1 : 0}`,
            ...metricHeader('zengate_backend_events_connected', 'gauge', 'Whether the OpenCode event stream is connected.'),
            `zengate_backend_events_connected ${gauges.eventsConnected ? 1 : 0}`,
            ...histogramLines('zengate_request_duration_seconds', 'Time from request start to the end of the response.', duration),
            ...histogramLines('zengate_time_to_first_token_seconds', 'Time from request start to the first generated text.', firstToken),
        ];
        return `${lines.join('\n')}\n`;
    }

    return Object.freeze({
        middleware,
        authFailure: () => { authFailures += 1; },
        rateLimited: () => { rateLimited += 1; },
        snapshot,
        prometheus,
    });
}
