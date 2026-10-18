/**
 * HTTP plumbing shared by the OpenCode API clients: Basic auth, timeouts,
 * error mapping and the event-stream request.
 */
export class BackendError extends Error {
    constructor(message, { status = 0, body = null, cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'BackendError';
        this.status = status;
        this.body = body;
    }
}

const DEFAULT_TIMEOUT_MS = 30000;

export function basicAuthHeader(username, password) {
    if (!password) return null;
    return `Basic ${Buffer.from(`${username || 'opencode'}:${password}`).toString('base64')}`;
}

/**
 * A backend URL as it may appear in logs and errors: scheme, host and port.
 * Credentials, a path and a query string can all carry secrets.
 * @param {string} url
 */
export function backendOrigin(url) {
    try {
        return new URL(url).origin;
    } catch {
        return '(invalid URL)';
    }
}

/**
 * @param {{ baseUrl: string, username?: string, password?: string, fetchImpl?: typeof fetch }} options
 */
export function createHttp({ baseUrl, username, password, fetchImpl = fetch }) {
    const base = String(baseUrl).replace(/\/+$/, '');
    const shownBase = backendOrigin(base);
    const auth = basicAuthHeader(username, password);
    const headers = (extra) => ({ accept: 'application/json', ...(auth ? { authorization: auth } : {}), ...extra });

    async function request(method, path, { body, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
        const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
        const combined = [signal, timeout].filter(Boolean);
        let response;
        try {
            response = await fetchImpl(`${base}${path}`, {
                method,
                redirect: 'error',
                headers: headers(body === undefined ? {} : { 'content-type': 'application/json' }),
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: combined.length > 1 ? AbortSignal.any(combined) : combined[0],
            });
        } catch (error) {
            if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
            throw new BackendError(`OpenCode backend unreachable at ${shownBase}: ${error?.cause?.code || error?.message}`, { cause: error });
        }
        const text = await response.text();
        let parsed = null;
        if (text) {
            try { parsed = JSON.parse(text); } catch { parsed = text; }
        }
        if (!response.ok) {
            throw new BackendError(`OpenCode ${method} ${path} failed with HTTP ${response.status}`, { status: response.status, body: parsed });
        }
        return parsed;
    }

    /** Opens a server-sent event stream; the caller consumes response.body. */
    async function openStream(path, signal) {
        const response = await fetchImpl(`${base}${path}`, { headers: headers({ accept: 'text/event-stream' }), signal, redirect: 'error' });
        if (!response.ok || !response.body) {
            throw new BackendError(`OpenCode event stream failed with HTTP ${response.status}`, { status: response.status });
        }
        return response;
    }

    return Object.freeze({ base, request, openStream });
}
