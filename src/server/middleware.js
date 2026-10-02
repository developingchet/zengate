import crypto from 'node:crypto';
import net from 'node:net';
import { clientKey } from './client-key.js';
import { ApiError, sendError } from './errors.js';

const PUBLIC_PATHS = new Set(['/health', '/ready']);

const BEARER = 'bearer';

/**
 * Constant-time comparison of the key bytes. Only the length can differ in
 * timing, and key lengths are not secret (generated keys have a fixed format).
 */
function safeEqual(presented, expected) {
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The key from `Authorization: Bearer <key>`, parsed without a backtracking regex. */
function presentedKey(req) {
    const header = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : '';
    const scheme = header.slice(0, BEARER.length);
    const separator = header.charAt(BEARER.length);
    if (scheme.toLowerCase() !== BEARER || !/\s/.test(separator)) return '';
    return header.slice(BEARER.length + 1).trim();
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
        const index = key ? apiKeys.findIndex((candidate) => safeEqual(key, candidate)) : -1;
        if (index !== -1) {
            // Names the matched key without deriving anything from it; scopes
            // stored responses to the key that made them.
            req.clientId = `key_${index}`;
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
        const ip = clientKey(req);
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

/** The name in a Host header, lower-cased, without port, brackets or a trailing dot. */
function hostName(header) {
    const value = String(header || '').trim().toLowerCase();
    if (value.startsWith('[')) return value.slice(1, value.indexOf(']'));
    return value.replace(/:\d*$/, '').replace(/\.$/, '');
}

/**
 * Without API keys, a web page could use the gateway through DNS rebinding:
 * its own domain is made to resolve to this host, so the browser treats the
 * gateway as same-origin. Such requests carry that domain as Host, so only
 * names that cannot be rebound are accepted: IP addresses, localhost and its
 * subdomains, and ALLOWED_HOSTS.
 * @param {{ allowedHosts: string[] }} options
 */
export function hostGuard({ allowedHosts }) {
    const allowed = new Set(['localhost', ...allowedHosts.map((host) => hostName(host))]);
    return (req, res, next) => {
        if (PUBLIC_PATHS.has(req.path)) return next();
        const host = hostName(req.headers.host);
        if (host && (allowed.has(host) || host.endsWith('.localhost') || net.isIP(host))) return next();
        return sendError(res, new ApiError(403,
            'This Host name is not accepted while ALLOW_NO_AUTH is on. Use an IP address or localhost, or add the name to ALLOWED_HOSTS.',
            { code: 'host_not_allowed' }));
    };
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
