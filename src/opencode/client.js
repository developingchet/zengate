import { BackendError, backendOrigin, basicAuthHeader, createHttp } from './http.js';

export { BackendError, backendOrigin, basicAuthHeader };

/**
 * Thin client for the documented OpenCode 1.x `opencode serve` HTTP API
 * (https://opencode.ai/docs/server/). Plain fetch keeps connections pooled
 * and avoids coupling the gateway to a specific SDK major version.
 *
 * OpenCode 2 serves a different API; see client-v2.js, which exposes this
 * same interface.
 *
 * @param {{ baseUrl: string, username?: string, password?: string, fetchImpl?: typeof fetch }} options
 */
export function createOpencodeClient(options) {
    const { base, request, openStream } = createHttp(options);
    const id = (value) => encodeURIComponent(value);

    return Object.freeze({
        api: 'v1',
        baseUrl: base,
        health: (requestOptions) => request('GET', '/global/health', { timeoutMs: 3000, ...requestOptions }),
        providers: (requestOptions) => request('GET', '/config/providers', requestOptions),
        agents: (requestOptions) => request('GET', '/agent', requestOptions),
        createSession: (requestOptions) => request('POST', '/session', { body: { title: 'openai-gateway' }, ...requestOptions }),
        deleteSession: (sessionId, requestOptions) => request('DELETE', `/session/${id(sessionId)}`, requestOptions),
        abortSession: (sessionId, requestOptions) => request('POST', `/session/${id(sessionId)}/abort`, { timeoutMs: 5000, ...requestOptions }),
        messages: (sessionId, requestOptions) => request('GET', `/session/${id(sessionId)}/message`, requestOptions),
        message: (sessionId, messageId, requestOptions) => request('GET', `/session/${id(sessionId)}/message/${id(messageId)}`, requestOptions),
        /** Blocks until the assistant turn finishes; returns { info, parts }. */
        prompt: (sessionId, body, requestOptions) => request('POST', `/session/${id(sessionId)}/message`, { body, timeoutMs: 0, ...requestOptions }),
        // OpenCode 1 addresses requests by id alone; the session id is only needed by OpenCode 2.
        replyPermission: (requestId, reply, message) =>
            request('POST', `/permission/${id(requestId)}/reply`, { body: { reply, ...(message ? { message } : {}) }, timeoutMs: 5000 }),
        rejectQuestion: (requestId) => request('POST', `/question/${id(requestId)}/reject`, { body: {}, timeoutMs: 5000 }),
        pendingPermissions: () => request('GET', '/permission', { timeoutMs: 5000 }),
        pendingQuestions: () => request('GET', '/question', { timeoutMs: 5000 }),
        /** Opens the server-sent event stream; caller consumes response.body. */
        openEvents: (signal) => openStream('/event', signal),
        /** The stream already carries the events the gateway consumes. */
        adaptEvent: (event) => [event],
    });
}
