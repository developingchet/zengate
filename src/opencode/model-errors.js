import { ApiError } from '../server/errors.js';
import { BackendError } from './client.js';

const MAX_DETAIL = 400;

function detail(error) {
    const message = error?.data?.message || error?.message || '';
    return String(message).replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL);
}

function retryAfter(error) {
    const headers = error?.data?.responseHeaders || {};
    const value = Number(headers['retry-after'] ?? headers['Retry-After']);
    return Number.isFinite(value) && value > 0 && value < 3600 ? Math.ceil(value) : 30;
}

/**
 * Translate an OpenCode assistant-message error into either a finish reason
 * (the turn produced a usable, if cut short, answer) or an ApiError to throw.
 * @returns {{ finish?: string, throw?: ApiError }}
 */
export function mapModelError(error) {
    const name = error?.name || 'UnknownError';
    const message = detail(error);
    switch (name) {
        case 'MessageOutputLengthError':
            return { finish: 'length' };
        case 'ContentFilterError':
            return { finish: 'content_filter' };
        case 'MessageAbortedError':
            return { throw: new ApiError(499, 'Request cancelled.', { code: 'cancelled' }) };
        case 'ContextOverflowError':
            return { throw: new ApiError(400, `The conversation is too long for this model's context window. ${message}`.trim(), { param: 'messages', code: 'context_length_exceeded' }) };
        case 'StructuredOutputError':
            return { throw: new ApiError(502, `The model did not produce output matching the requested JSON schema. ${message}`.trim(), { code: 'structured_output_failed' }) };
        case 'ProviderAuthError':
            return { throw: new ApiError(502, `OpenCode Zen refused the request: ${message}`, { code: 'upstream_auth_failed' }) };
        case 'APIError': {
            const status = Number(error?.data?.statusCode) || 502;
            if (status === 429) {
                return { throw: new ApiError(429, `OpenCode Zen rate limit reached for this model; retry later. ${message}`.trim(), { code: 'upstream_rate_limited', retryAfter: retryAfter(error) }) };
            }
            if (status === 400 || status === 413 || status === 422) {
                return { throw: new ApiError(400, `The model rejected the request: ${message}`, { code: 'upstream_rejected' }) };
            }
            if (status === 401 || status === 403) {
                return { throw: new ApiError(502, `OpenCode Zen refused the request: ${message}`, { code: 'upstream_refused' }) };
            }
            return { throw: new ApiError(502, `The model provider failed: ${message}`, { code: 'upstream_error' }) };
        }
        default:
            return { throw: new ApiError(502, `The model provider failed: ${message || name}`, { code: 'upstream_error' }) };
    }
}

/** Translate an HTTP-level backend failure into an ApiError. */
export function mapBackendError(error) {
    if (error instanceof ApiError) return error;
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return error;
    if (error instanceof BackendError && error.status === 400) {
        const raw = error.body && typeof error.body === 'object' ? JSON.stringify(error.body) : String(error.body || 'no details');
        const message = raw.slice(0, MAX_DETAIL);
        return new ApiError(400, `OpenCode rejected the request: ${message}`, { code: 'backend_rejected', cause: error });
    }
    return new ApiError(503, 'The OpenCode backend is unavailable; retry shortly.', { code: 'backend_unavailable', retryAfter: 2, cause: error });
}
