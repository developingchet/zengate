import crypto from 'node:crypto';
import { ApiError, sendError } from './errors.js';

const PUBLIC_PATHS = new Set(['/health', '/ready']);

/** Constant-time comparison; hashing first hides the key length. */
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function presentedKey(req) {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1].trim() : '';
}

/**
 * Gateway authentication. Clients send `Authorization: Bearer <API_KEY>`,
 * which is what every OpenAI SDK does with its api key setting.
 */
export function authMiddleware({ apiKeys, allowNoAuth, onFailure }) {
    return (req, res, next) => {
        req.clientId = 'anonymous';
        if (allowNoAuth || PUBLIC_PATHS.has(req.path) || req.method === 'OPTIONS') return next();
        const key = presentedKey(req);
        if (key && apiKeys.some((candidate) => safeEqual(key, candidate))) {
            // Opaque per-key id: scopes stored responses to the key that made them.
            req.clientId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
            return next();
        }
        onFailure?.();
        res.set('WWW-Authenticate', 'Bearer');
        return sendError(res, new ApiError(401, key
            ? 'Incorrect API key provided.'
            : 'Missing API key. Send it as "Authorization: Bearer <API_KEY>".', { code: 'invalid_api_key' }));
    };
}

/**
 * Per-client token bucket (burst = limit, refill = limit per minute).
 * O(1) memory per client; idle entries are swept every minute.
 */
export function rateLimitMiddleware({ perMinute, onLimited, maxClients = 50000 }) {
    const buckets = new Map();
    const refillPerMs = perMinute / 60000;
    const sweep = setInterval(() => {
        const cutoff = Date.now() - 120000;
        for (const [ip, bucket] of buckets) if (bucket.at < cutoff) buckets.delete(ip);
    }, 60000);
    sweep.unref();

    const middleware = (req, res, next) => {
        if (perMinute <= 0 || PUBLIC_PATHS.has(req.path)) return next();
        const ip = req.ip || req.socket?.remoteAddress || 'unknown';
        const now = Date.now();
        let bucket = buckets.get(ip);
        if (!bucket) {
            if (buckets.size >= maxClients) buckets.delete(buckets.keys().next().value);
            bucket = { tokens: perMinute, at: now };
            buckets.set(ip, bucket);
        }
        bucket.tokens = Math.min(perMinute, bucket.tokens + (now - bucket.at) * refillPerMs);
        bucket.at = now;
        if (bucket.tokens < 1) {
            onLimited?.();
            const retryAfter = Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000));
            return sendError(res, new ApiError(429, 'Rate limit reached for this client; slow down.', { code: 'rate_limit_exceeded', retryAfter }));
        }
        bucket.tokens -= 1;
        return next();
    };
    middleware.close = () => clearInterval(sweep);
    return middleware;
}

export function securityHeaders(req, res, next) {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
    });
    next();
}

/** Per-request id (echoes a client-supplied one when it looks sane). */
export function requestId(req, res, next) {
    const incoming = req.headers['x-request-id'];
    req.id = typeof incoming === 'string' && /^[\w.-]{1,64}$/.test(incoming) ? incoming : `req_${crypto.randomBytes(12).toString('hex')}`;
    res.set('x-request-id', req.id);
    next();
}
