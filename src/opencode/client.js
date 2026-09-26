/**
 * Thin client for the documented `opencode serve` HTTP API
 * (https://opencode.ai/docs/server/). Plain fetch keeps connections pooled
 * and avoids coupling the gateway to a specific SDK major version.
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
 * @param {{ baseUrl: string, username?: string, password?: string, fetchImpl?: typeof fetch }} options
 */
export function createOpencodeClient({ baseUrl, username, password, fetchImpl = fetch }) {
    const base = String(baseUrl).replace(/\/+$/, '');
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
            throw new BackendError(`OpenCode backend unreachable at ${base}: ${error?.cause?.code || error?.message}`, { cause: error });
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

    const id = (value) => encodeURIComponent(value);

    return Object.freeze({
        baseUrl: base,
        health: (options) => request('GET', '/global/health', { timeoutMs: 3000, ...options }),
        providers: (options) => request('GET', '/config/providers', options),
        agents: (options) => request('GET', '/agent', options),
        createSession: (options) => request('POST', '/session', { body: { title: 'openai-gateway' }, ...options }),
        deleteSession: (sessionId, options) => request('DELETE', `/session/${id(sessionId)}`, options),
        abortSession: (sessionId, options) => request('POST', `/session/${id(sessionId)}/abort`, { timeoutMs: 5000, ...options }),
        messages: (sessionId, options) => request('GET', `/session/${id(sessionId)}/message`, options),
        /** Blocks until the assistant turn finishes; returns { info, parts }. */
        prompt: (sessionId, body, options) => request('POST', `/session/${id(sessionId)}/message`, { body, timeoutMs: 0, ...options }),
        replyPermission: (requestId, reply, message) =>
            request('POST', `/permission/${id(requestId)}/reply`, { body: { reply, ...(message ? { message } : {}) }, timeoutMs: 5000 }),
        rejectQuestion: (requestId) => request('POST', `/question/${id(requestId)}/reject`, { body: {}, timeoutMs: 5000 }),
        pendingPermissions: () => request('GET', '/permission', { timeoutMs: 5000 }),
        pendingQuestions: () => request('GET', '/question', { timeoutMs: 5000 }),
        /** Opens the server-sent event stream; caller consumes response.body. */
        async openEvents(signal) {
            const response = await fetchImpl(`${base}/event`, { headers: headers({ accept: 'text/event-stream' }), signal, redirect: 'error' });
            if (!response.ok || !response.body) {
                throw new BackendError(`OpenCode event stream failed with HTTP ${response.status}`, { status: response.status });
            }
            return response;
        },
    });
}
