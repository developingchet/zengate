const ALLOWED_METHODS = 'GET,HEAD,POST,DELETE,OPTIONS';
// A comma-separated list of HTTP header names (RFC 9110 tokens).
const HEADER_LIST = /^[!#$%&'*+.^`|~\w-]+(?:\s*,\s*[!#$%&'*+.^`|~\w-]+)*$/;

/**
 * CORS for an explicit list of browser origins. Origins are matched exactly,
 * credentials are never allowed, and preflights are answered directly.
 * @param {{ origins: string[], exposedHeaders: string[], maxAge: number }} options
 */
export function corsMiddleware({ origins, exposedHeaders, maxAge }) {
    const allowed = new Set(origins);
    const exposed = exposedHeaders.join(',');

    return (req, res, next) => {
        const origin = req.headers.origin;
        if (!origin) return next();
        res.vary('Origin');
        const granted = allowed.has(origin);
        const isPreflight = req.method === 'OPTIONS' && Boolean(req.headers['access-control-request-method']);

        if (!isPreflight) {
            if (granted) res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': exposed });
            return next();
        }
        if (granted) {
            const requested = String(req.headers['access-control-request-headers'] || '').trim();
            res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': ALLOWED_METHODS, 'Access-Control-Max-Age': String(maxAge) });
            if (requested && HEADER_LIST.test(requested)) res.set('Access-Control-Allow-Headers', requested);
            res.vary('Access-Control-Request-Headers');
        }
        return res.status(204).end();
    };
}
