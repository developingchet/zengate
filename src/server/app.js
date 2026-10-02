import express from 'express';
import { chatCompletionsHandler } from '../openai/chat.js';
import { completionsHandler } from '../openai/completions.js';
import { modelsHandlers } from '../openai/models.js';
import { responsesHandlers } from '../openai/responses.js';
import { corsMiddleware } from './cors.js';
import { ApiError, sendError, toApiError } from './errors.js';
import { admissionMiddleware, createLimiter } from './limiter.js';
import { createMetrics } from './metrics.js';
import { authMiddleware, rateLimitMiddleware, requestId, securityHeaders } from './middleware.js';
import { slotMiddleware } from './slot.js';

const MB = 1024 * 1024;
const EXPOSED_HEADERS = ['x-request-id', 'x-gateway-ignored-params', 'Retry-After'];
const PROBE_PATHS = new Set(['/health', '/ready']);

/** Wrap an async handler so rejections reach the error handler. */
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function openAiRoutes({ runner, catalog, store, limits }) {
    const router = express.Router();
    const models = modelsHandlers({ catalog });
    const responses = responsesHandlers({ runner, catalog, store, limits });
    router.get('/models', route(models.list));
    router.get('/models/*id', route(models.retrieve));
    router.post('/chat/completions', route(chatCompletionsHandler({ runner, catalog, limits })));
    router.post('/completions', route(completionsHandler({ runner, catalog })));
    router.post('/embeddings', () => {
        throw new ApiError(404, 'Embeddings are not available: OpenCode Zen serves chat models only.', { code: 'unsupported_endpoint' });
    });
    router.post('/responses', route(responses.create));
    router.get('/responses/:id', route(responses.retrieve));
    router.delete('/responses/:id', route(responses.remove));
    return router;
}

/** Adds `req.log` and writes an access-log line for every request except probes. */
function requestLogger(logger) {
    return (req, res, next) => {
        const scoped = (level) => (msg, fields) => logger[level](msg, { requestId: req.id, ...fields });
        req.log = { debug: scoped('debug'), info: scoped('info'), warn: scoped('warn'), error: scoped('error') };
        if (!PROBE_PATHS.has(req.path)) {
            const started = performance.now();
            res.once('close', () => {
                const path = req.originalUrl.split('?')[0];
                req.log.info(`${req.method} ${path} ${res.statusCode}`, {
                    ms: Math.round(performance.now() - started),
                    client: req.clientId,
                    ...(res.writableFinished ? {} : { aborted: true }),
                });
            });
        }
        next();
    };
}

function errorHandler(error, req, res, next) {
    const apiError = toApiError(error);
    if (apiError.status >= 500 && apiError.status !== 504) {
        req.log.error('Request failed', { status: apiError.status, error: error?.message, cause: error?.cause?.message });
    } else {
        req.log.debug('Request rejected', { status: apiError.status, code: apiError.code, error: apiError.message });
    }
    if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return undefined;
    }
    if (req.socket.destroyed) return undefined;
    void next;
    return sendError(res, apiError);
}

/**
 * The HTTP surface. OpenAI routes are served under /v1 and, for clients
 * configured with a bare base URL, at the root as well.
 * @param {{ config: object, logger: object, backend: object, hub: object, catalog: object, runner: object, store: object }} deps
 */
export function createApp({ config, logger, backend, hub, catalog, runner, store }) {
    const app = express();
    const metrics = createMetrics();
    const limiter = createLimiter({ maxConcurrent: config.MAX_CONCURRENT, maxQueue: config.MAX_QUEUE, queueTimeoutMs: config.QUEUE_TIMEOUT_MS });
    const admission = admissionMiddleware({ limit: config.MAX_CONCURRENT + config.MAX_QUEUE });
    const rateLimit = rateLimitMiddleware({ perMinute: config.RATE_LIMIT_PER_MINUTE, onLimited: metrics.rateLimited });
    const limits = { maxBytes: config.MAX_MEDIA_MB * MB, maxTotalBytes: config.MAX_BODY_MB * MB };
    let draining = false;

    app.disable('x-powered-by');
    app.set('trust proxy', config.TRUST_PROXY || false);
    app.use(requestId, securityHeaders, metrics.middleware, requestLogger(logger));
    if (config.CORS_ORIGINS.length) {
        app.use(corsMiddleware({ origins: config.CORS_ORIGINS, exposedHeaders: EXPOSED_HEADERS, maxAge: 600 }));
    }

    app.get('/health', (req, res) => res.json({ status: 'ok' }));
    app.get('/ready', (req, res) => {
        const ready = !draining && backend.isReady() && hub.isConnected();
        const status = draining ? 'stopping' : (ready ? 'ready' : 'starting');
        res.status(ready ? 200 : 503).json({ status, backend: backend.mode });
    });

    app.use(rateLimit);
    app.use(authMiddleware({ apiKeys: config.API_KEYS, allowNoAuth: config.ALLOW_NO_AUTH, onFailure: metrics.authFailure }));
    app.get('/metrics', (req, res) => {
        const slots = { ...limiter.stats(), admitted: admission.count() };
        const toolRejections = hub.toolRejections?.() ?? 0;
        // Prometheus asks for OpenMetrics or text/plain with a version parameter, which
        // req.accepts() does not match; browsers and curl get JSON.
        const accept = String(req.headers.accept || '');
        const scraper = /openmetrics-text|text\/plain/.test(accept) && !accept.includes('application/json');
        if (req.query.format === 'prometheus' || (req.query.format === undefined && scraper)) {
            res.type('text/plain; version=0.0.4').send(metrics.prometheus({
                slots, storedResponses: store.size(), backendReady: backend.isReady(), eventsConnected: hub.isConnected(),
                toolRejections, opencode: backend.version(),
            }));
            return;
        }
        res.json(metrics.snapshot({
            slots,
            stored_responses: store.size(),
            backend_ready: backend.isReady(),
            events_connected: hub.isConnected(),
            tool_rejections: toolRejections,
            opencode: backend.version(),
        }));
    });
    app.use(admission);
    app.use(express.json({ limit: config.MAX_BODY_MB * MB }));
    app.use(slotMiddleware({ limiter, timeoutMs: config.REQUEST_TIMEOUT_MS }));

    const routes = openAiRoutes({ runner, catalog, store, limits });
    app.use('/v1', routes);
    app.use(routes);

    app.use((req, res) => sendError(res, new ApiError(404, `Unknown endpoint: ${req.method} ${req.path}`, { code: 'unknown_url' })));
    app.use(errorHandler);

    return {
        app,
        /** Report "not ready" so load balancers stop sending new requests. */
        startDraining: () => { draining = true; },
        close: () => rateLimit.close(),
    };
}
