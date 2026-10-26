/** Validated provider timing. No guessed cooldown when timing is unknown. */
export function retryTiming(data = {}, now = Date.now()) {
    const seconds = (value) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER / 1000
        ? Math.ceil(value) : undefined;
    if (typeof data.retryAfterMs === 'number' && Number.isSafeInteger(data.retryAfterMs) && data.retryAfterMs >= 0) {
        return seconds(data.retryAfterMs / 1000);
    }
    const headers = data.responseHeaders || {};
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
    if (typeof entry === 'string' || typeof entry === 'number') {
        const text = String(entry).trim();
        if (/^\d+(?:\.\d+)?$/.test(text)) {
            const delay = seconds(Number(text));
            if (delay !== undefined) return delay;
        } else if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) {
            const timestamp = Date.parse(text);
            if (Number.isFinite(timestamp)) return seconds(Math.max(0, timestamp - now) / 1000);
        }
    }
    // resetAt is an epoch millisecond timestamp or an ISO timestamp, never guessed seconds.
    const reset = typeof data.resetAt === 'number' ? data.resetAt
        : typeof data.resetAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(data.resetAt) ? Date.parse(data.resetAt) : NaN;
    if (Number.isSafeInteger(reset) && reset >= 0) return seconds(Math.max(0, reset - now) / 1000);
    return undefined;
}

const QUOTA_TYPES = new Set(['provider.free-limit', 'provider.quota', 'insufficient_quota', 'quota_exceeded', 'FreeUsageLimitError']);

export function isQuotaError(error) {
    const data = error?.data || {};
    if ([error?.name, data.type, data.code].some((value) => QUOTA_TYPES.has(value))) return true;
    // V1 APIError retains the provider's structured JSON body as a string.
    if (typeof data.responseBody !== 'string') return false;
    try {
        const body = JSON.parse(data.responseBody);
        return [body?.type, body?.code, body?.error?.type, body?.error?.code, body?.error?.name].some((value) => QUOTA_TYPES.has(value));
    } catch { return false; }
}
