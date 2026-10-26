import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapModelError } from '../src/opencode/model-errors.js';
import { errorFromV2 } from '../src/opencode/v2-convert.js';
import { retryTiming } from '../src/opencode/retry-timing.js';
import { readSse, startStack } from './helpers/gateway.mjs';
import { streamTurn } from './helpers/fake-opencode.mjs';

describe('provider quota and retry timing', () => {
    it('preserves structured V2 quota classification and multi-hour timing without arbitrary provider text', () => {
        for (const type of ['provider.free-limit', 'provider.quota']) {
            const mapped = mapModelError(errorFromV2({ type, message: 'private upstream details', status: 429, retryAfterMs: 7200123 })).throw;
            assert.equal(mapped.status, 429);
            assert.equal(mapped.code, 'upstream_quota_exhausted');
            assert.equal(mapped.retryAfter, 7201);
            assert.doesNotMatch(mapped.message, /private/);
        }
        const noTiming = mapModelError(errorFromV2({ type: 'provider.free-limit' })).throw;
        assert.equal(noTiming.code, 'upstream_quota_exhausted');
        assert.equal(noTiming.retryAfter, undefined);
        const v1 = mapModelError({ name: 'APIError', data: { statusCode: 429, responseBody: JSON.stringify({ error: { code: 'insufficient_quota' } }) } }).throw;
        assert.equal(v1.code, 'upstream_quota_exhausted');
        const transient = mapModelError(errorFromV2({ type: 'provider.rate-limit', status: 429, retryAfterMs: 1234 })).throw;
        assert.equal(transient.code, 'upstream_rate_limited');
        assert.equal(transient.retryAfter, 2);
    });

    it('validates milliseconds, long delays, HTTP dates and explicit reset timestamps', () => {
        const now = Date.parse('2026-10-26T12:00:00Z');
        assert.equal(retryTiming({ retryAfterMs: 0 }, now), 0);
        assert.equal(retryTiming({ responseHeaders: { 'RETRY-AFTER': '99999' } }, now), 99999);
        assert.equal(retryTiming({ responseHeaders: { 'Retry-After': 'Mon, 26 Oct 2026 14:00:00 GMT' } }, now), 7200);
        assert.equal(retryTiming({ resetAt: now + 7200500 }, now), 7201);
        assert.equal(retryTiming({ resetAt: '2026-10-26T14:00:00Z' }, now), 7200);
        for (const value of [-1, Infinity, NaN, '7200000', null, {}, true]) assert.equal(retryTiming({ retryAfterMs: value }, now), undefined);
        for (const value of ['soon', '', '-10', 'Infinity', '123abc', '10\r\nsecret', [], {}]) {
            assert.equal(retryTiming({ responseHeaders: { 'retry-after': value } }, now), undefined);
        }
        assert.equal(retryTiming({}, now), undefined);
    });

    it('exposes the same quota code and timing over HTTP and both streaming APIs', async () => {
        const stack = await startStack();
        try {
            for (const retryAfterMs of [7200000, undefined]) {
                stack.fake.setBehavior((ctx) => streamTurn(ctx, { error: errorFromV2({ type: 'provider.free-limit', status: 429, retryAfterMs }) }));
                const body = { model: 'big-pickle', messages: [{ role: 'user', content: 'hello' }] };
                const response = await stack.json('/v1/chat/completions', { body });
                assert.equal(response.status, 429);
                assert.equal(response.headers.get('retry-after'), retryAfterMs === undefined ? null : '7200');
                assert.equal(response.body.error.code, 'upstream_quota_exhausted');
                assert.equal(response.body.error.retry_after, retryAfterMs === undefined ? undefined : 7200);
                const chat = await readSse(await stack.request('/v1/chat/completions', { body: { ...body, stream: true } }));
                const error = chat.find((frame) => frame.data?.error)?.data.error;
                assert.equal(error.code, response.body.error.code);
                assert.equal(error.retry_after, response.body.error.retry_after);
                const frames = await readSse(await stack.request('/v1/responses', { body: { model: 'big-pickle', input: 'hello', stream: true } }));
                const failed = frames.find((frame) => frame.event === 'response.failed').data.response.error;
                assert.equal(failed.code, error.code);
                assert.equal(failed.retry_after, error.retry_after);
            }
        } finally { await stack.stop(); }
    });
});
