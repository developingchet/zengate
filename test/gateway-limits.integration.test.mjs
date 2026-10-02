import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { loadConfig } from '../src/config.js';
import { startGateway } from '../src/gateway.js';
import { silentLogger } from '../src/logger.js';
import { createAttachedBackend } from '../src/opencode/backend.js';
import { startFakeOpencode, streamTurn, waitFor } from './helpers/fake-opencode.mjs';
import { KEY, startStack } from './helpers/gateway.mjs';

const ORIGIN = 'https://app.example';
const body = (extra = {}) => ({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }], ...extra });

/** Behavior that never answers until the gateway aborts the session or drops the request. */
const hang = async (ctx) => {
    await ctx.untilAborted;
    return null;
};

describe('gateway limits and cancellation', () => {
    let stack;
    before(async () => {
        stack = await startStack({
            env: { MAX_CONCURRENT: '1', MAX_QUEUE: '0', CORS_ORIGINS: ORIGIN, RATE_LIMIT_PER_MINUTE: '1000' },
            overrides: { REQUEST_TIMEOUT_MS: 400, MAX_BODY_MB: 0.01 },
        });
    });
    after(async () => { await stack?.stop(); });
    afterEach(() => stack.fake.setBehavior(null));

    const slots = async () => (await stack.json('/metrics')).body.slots;
    const idle = () => waitFor(async () => (await slots()).active === 0);

    it('times out a stuck generation with 504, aborts the session and frees the slot', async () => {
        stack.fake.setBehavior(hang);
        const aborted = stack.fake.state.aborted.length;
        const started = Date.now();
        const { status, body: error } = await stack.json('/v1/chat/completions', { body: body() });
        assert.equal(status, 504);
        assert.equal(error.error.code, 'timeout');
        assert.match(error.error.message, /REQUEST_TIMEOUT_MS/);
        assert.ok(Date.now() - started < 5000);
        await waitFor(() => stack.fake.state.aborted.length > aborted);
        await idle();
        stack.fake.setBehavior(null);
        assert.equal((await stack.json('/v1/chat/completions', { body: body() })).status, 200, 'the slot is usable again');
    });

    it('answers 429 when the queue is full, and a client disconnect frees the slot', async () => {
        stack.fake.setBehavior(hang);
        const prompts = stack.fake.state.prompts.length;
        const controller = new AbortController();
        const first = stack.request('/v1/chat/completions', { body: body(), signal: controller.signal }).catch((error) => error);
        await waitFor(() => stack.fake.state.prompts.length > prompts);
        assert.equal((await slots()).active, 1);

        const busy = await stack.json('/v1/chat/completions', { body: body() });
        assert.equal(busy.status, 429);
        assert.equal(busy.body.error.code, 'server_busy');
        assert.equal(busy.headers.get('retry-after'), '2');

        const aborted = stack.fake.state.aborted.length;
        controller.abort();
        assert.equal((await first).name, 'AbortError');
        await idle();
        await waitFor(() => stack.fake.state.aborted.length > aborted);
        stack.fake.setBehavior(null);
        assert.equal((await stack.json('/v1/chat/completions', { body: body() })).status, 200);
    });

    it('frees the slot when a streaming client disconnects mid-stream', async () => {
        stack.fake.setBehavior(async (ctx) => {
            await streamTurn(ctx, { text: 'partial', settleMs: 0 });
            await ctx.untilAborted;
            return null;
        });
        const controller = new AbortController();
        const response = await stack.request('/v1/chat/completions', { body: body({ stream: true }), signal: controller.signal });
        const reader = response.body.getReader();
        let received = '';
        while (!received.includes('partial')) received += new TextDecoder().decode((await reader.read()).value);
        controller.abort();
        await idle();
    });

    it('streams a timeout error into the SSE stream', async () => {
        stack.fake.setBehavior(hang);
        const response = await stack.request('/v1/chat/completions', { body: body({ stream: true }) });
        const text = await response.text();
        assert.match(text, /"code":"timeout"/);
        assert.match(text, /data: \[DONE\]\n\n$/);
        await idle();
    });

    it('fails a streaming Responses request on timeout', async () => {
        stack.fake.setBehavior(hang);
        const response = await stack.request('/v1/responses', { body: { model: 'big-pickle', input: 'x', stream: true } });
        const text = await response.text();
        assert.match(text, /event: response\.failed/);
        await idle();
    });

    it('clamps n above MAX_CONCURRENT to the available slots', async () => {
        const { status, body: completion } = await stack.json('/v1/chat/completions', { body: body({ n: 2 }) });
        assert.equal(status, 200);
        assert.equal(completion.choices.length, 2);
    });

    it('rejects bodies over MAX_BODY_MB with 413', async () => {
        const { status, body: error } = await stack.json('/v1/chat/completions', { body: body({ messages: [{ role: 'user', content: 'x'.repeat(20000) }] }) });
        assert.equal(status, 413);
        assert.equal(error.error.code, 'request_too_large');
    });

    it('serves CORS for configured origins only', async () => {
        const preflight = await stack.request('/v1/chat/completions', {
            method: 'OPTIONS', key: null, headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
        });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
        const allowed = await stack.request('/v1/models', { headers: { origin: ORIGIN } });
        assert.equal(allowed.headers.get('access-control-allow-origin'), ORIGIN);
        assert.match(allowed.headers.get('access-control-expose-headers'), /x-request-id/);
        const other = await stack.request('/v1/models', { headers: { origin: 'https://evil.example' } });
        assert.equal(other.headers.get('access-control-allow-origin'), null);
    });
});

describe('gateway rate limiting and open mode', () => {
    let stack;
    before(async () => { stack = await startStack({ env: { RATE_LIMIT_PER_MINUTE: '2', ALLOW_NO_AUTH: 'true' } }); });
    after(async () => { await stack?.stop(); });

    it('serves without a key when ALLOW_NO_AUTH is on and rate limits per client', async () => {
        assert.equal((await stack.request('/v1/models', { key: null })).status, 200);
        assert.equal((await stack.request('/v1/models', { key: null })).status, 200);
        const limited = await stack.json('/v1/models', { key: null });
        assert.equal(limited.status, 429);
        assert.equal(limited.body.error.code, 'rate_limit_exceeded');
        assert.ok(Number(limited.headers.get('retry-after')) >= 1);
        assert.equal((await stack.request('/health', { key: null })).status, 200, 'health is never rate limited');
    });
});

describe('gateway startup and shutdown', () => {
    it('reports a busy port clearly and cleans up', async () => {
        const blocker = net.createServer();
        await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
        const fake = await startFakeOpencode();
        try {
            const config = { ...loadConfig({}, { API_KEY: KEY }), PORT: blocker.address().port };
            const backend = createAttachedBackend({ url: fake.url, username: 'opencode', password: '', logger: silentLogger });
            await assert.rejects(startGateway(config, { logger: silentLogger, backend }), /already in use/);
            await waitFor(() => fake.eventClientCount() === 0);
        } finally {
            await fake.close();
            await new Promise((resolve) => blocker.close(resolve));
        }
    });

    it('refuses to start when the attached backend is unhealthy', async () => {
        const fake = await startFakeOpencode();
        fake.state.healthy = false;
        try {
            const config = { ...loadConfig({}, { API_KEY: KEY }), PORT: 0 };
            const backend = createAttachedBackend({ url: fake.url, username: 'opencode', password: 'secret', logger: silentLogger });
            await assert.rejects(startGateway(config, { logger: silentLogger, backend }), /not healthy/);
        } finally {
            await fake.close();
        }
    });

    it('starts when the model list is not available yet and serves 503 for models', async () => {
        const fake = await startFakeOpencode();
        fake.state.providersFail = true;
        const config = { ...loadConfig({}, { API_KEY: KEY, RATE_LIMIT_PER_MINUTE: '0' }), PORT: 0 };
        const backend = createAttachedBackend({ url: fake.url, username: 'opencode', password: '', logger: silentLogger });
        const gateway = await startGateway(config, { logger: silentLogger, backend });
        try {
            const response = await fetch(`http://127.0.0.1:${gateway.address.port}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } });
            assert.equal(response.status, 503);
            assert.equal((await response.json()).error.code, 'backend_unavailable');
            assert.equal(response.headers.get('retry-after'), '2');
        } finally {
            await gateway.stop();
            await gateway.stop();
            await fake.close();
        }
    });

    it('keeps answering /ready with 503 for a moment before it stops listening', async () => {
        const stack = await startStack({ shutdownNoticeMs: 400 });
        const ready = () => fetch(`${stack.base}/ready`).then(async (r) => ({ status: r.status, body: await r.json() }));
        assert.equal((await ready()).status, 200);
        const stopping = stack.stop();
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepEqual(await ready(), { status: 503, body: { status: 'stopping', backend: 'attached' } });
        await stopping;
        await assert.rejects(ready(), 'the listener is closed afterwards');
    });
});
