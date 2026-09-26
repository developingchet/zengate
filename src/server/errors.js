/**
 * Errors surfaced to API clients use the OpenAI error envelope:
 * { "error": { "message", "type", "param", "code" } }.
 */
export class ApiError extends Error {
    /**
     * @param {number} status HTTP status
     * @param {string} message client-safe message
     * @param {{ type?: string, param?: string|null, code?: string|null, retryAfter?: number, cause?: unknown }} [options]
     */
    constructor(status, message, { type, param = null, code = null, retryAfter, cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'ApiError';
        this.status = status;
        this.type = type ?? defaultType(status);
        this.param = param;
        this.code = code;
        this.retryAfter = retryAfter;
    }

    toJSON() {
        return { error: { message: this.message, type: this.type, param: this.param, code: this.code } };
    }
}

function defaultType(status) {
    if (status === 401) return 'authentication_error';
    if (status === 403) return 'permission_error';
    if (status === 404) return 'not_found_error';
    if (status === 429) return 'rate_limit_error';
    if (status >= 500) return 'server_error';
    return 'invalid_request_error';
}

export const invalidRequest = (message, param = null, code = null) => new ApiError(400, message, { param, code });

export const unsupported = (message, param = null) => new ApiError(400, message, { param, code: 'unsupported_parameter' });

/** Normalize anything thrown into an ApiError without leaking internals. */
export function toApiError(error) {
    if (error instanceof ApiError) return error;
    if (error?.type === 'entity.too.large') {
        return new ApiError(413, 'Request body too large. Raise MAX_BODY_MB if this is expected.', { code: 'request_too_large' });
    }
    if (error?.type === 'entity.parse.failed') return invalidRequest('Request body is not valid JSON.');
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        return new ApiError(504, 'The model did not finish before REQUEST_TIMEOUT_MS.', { code: 'timeout' });
    }
    return new ApiError(500, 'Internal server error.');
}

export function sendError(res, error) {
    const apiError = toApiError(error);
    if (apiError.retryAfter) res.set('Retry-After', String(apiError.retryAfter));
    res.status(apiError.status).json(apiError.toJSON());
}
