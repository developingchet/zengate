import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ApiError, invalidRequest, sendError, toApiError, unsupported } from '../src/server/errors.js';
import { createLimiter } from '../src/server/limiter.js';
import { createMetrics } from '../src/server/metrics.js';
import { authMiddleware, rateLimitMiddleware, requestId, securityHeaders } from '../src/server/middleware.js';
import { slotMiddleware } from '../src/server/slot.js';
import { fakeReq, fakeRes, run } from './helpers/fake-http.mjs';

const KEY = 'test-key-0123456789abcdef';

describe('errors', () => {
    it('derives the error type from the status', () => {
        const cases = [[400, 'invalid_request_error'], [401, 'authentication_error'], [403, 'permission_error'],
            [404, 'not_found_error'], [429, 'rate_limit_error'], [500, 'server_error'], [503, 'server_error']];
        for (const [status, type] of cases) assert.equal(new ApiError(status, 'x').type, type);
        assert.equal(new ApiError(400, 'x', { type: 'custom' }).type, 'custom');
    });

    it('serializes to the OpenAI error envelope', () => {
        const error = new ApiError(400, 'Bad thing', { param: 'model', code: 'bad', cause: new Error('inner') });
        assert.deepEqual(error.toJSON(), { error: { message: 'Bad thing', type: 'invalid_request_error', param: 'model', code: 'bad' } });
        assert.equal(error.cause.message, 'inner');
        assert.deepEqual(invalidRequest('m', 'p', 'c').toJSON().error, { message: 'm', type: 'invalid_request_error', param: 'p', code: 'c' });
        assert.equal(unsupported('m', 'p').code, 'unsupported_parameter');
        assert.equal(unsupported('m').param, null);
    });

    it('maps arbitrary errors without leaking internals', () => {
        const api = new ApiError(418, 'teapot');
        assert.equal(toApiError(api), api);
        assert.equal(toApiError({ type: 'entity.too.large' }).status, 413);
        assert.equal(toApiError({ type: 'entity.too.large' }).code, 'request_too_large');
        const parse = toApiError({ type: 'entity.parse.failed' });
        assert.equal(parse.status, 400);
        assert.match(parse.message, /not valid JSON/);
        for (const name of ['AbortError', 'TimeoutError']) {
            const mapped = toApiError(Object.assign(new Error('x'), { name }));
            assert.equal(mapped.status, 504);
            assert.equal(mapped.code, 'timeout');
        }
        const internal = toApiError(new Error('secret path /etc/passwd'));
        assert.equal(internal.status, 500);
        assert.equal(internal.message, 'Internal server error.');
        assert.equal(toApiError(undefined).status, 500);
    });

    it('sendError writes status, body and Retry-After', () => {
        const res = fakeRes();
        sendError(res, new ApiError(429, 'slow', { retryAfter: 7, code: 'rate' }));
        assert.equal(res.statusCode, 429);
        assert.equal(res.headers['Retry-After'], '7');
        assert.equal(res.body.error.code, 'rate');
        const plain = fakeRes();
        sendError(plain, new Error('boom'));
        assert.equal(plain.statusCode, 500);
        assert.equal(plain.headers['Retry-After'], undefined);
    });
});

describe('limiter', () => {
    it('grants up to maxConcurrent slots and queues FIFO', async () => {
        const limiter = createLimiter({ maxConcurrent: 2, maxQueue: 5 });
        const r1 = await limiter.acquire();
        const r2 = await limiter.acquire();
        assert.deepEqual(limiter.stats(), { active: 2, queued: 0, maxConcurrent: 2, maxQueue: 5 });
        const order = [];
        const p3 = limiter.acquire().then((release) => { order.push(3); return release; });
        const p4 = limiter.acquire().then((release) => { order.push(4); return release; });
        assert.equal(limiter.stats().queued, 2);
        r1();
        const r3 = await p3;
        assert.deepEqual(order, [3]);
        r2();
        const r4 = await p4;
        assert.deepEqual(order, [3, 4]);
        r3();
        r4();
        assert.equal(limiter.stats().active, 0);
    });

    it('rejects with 429 when the queue is full', async () => {
        const limiter = createLimiter({ maxConcurrent: 1, maxQueue: 0 });
        const release = await limiter.acquire();
        await assert.rejects(limiter.acquire(), (error) => error.status === 429 && error.code === 'server_busy' && error.retryAfter === 2);
        release();
        const again = await limiter.acquire();
        again();
    });

    it('release is idempotent', async () => {
        const limiter = createLimiter({ maxConcurrent: 1, maxQueue: 1 });
        const release = await limiter.acquire();
        release();
        release();
        assert.equal(limiter.stats().active, 0);
        const a = await limiter.acquire();
        assert.equal(limiter.stats().active, 1);
        a();
    });

    it('an abort releases a held slot', async () => {
        const limiter = createLimiter({ maxConcurrent: 1, maxQueue: 1 });
        const controller = new AbortController();
        const release = await limiter.acquire(controller.signal);
        assert.equal(limiter.stats().active, 1);
        controller.abort();
        assert.equal(limiter.stats().active, 0);
        release();
        assert.equal(limiter.stats().active, 0, 'late release does not double-free');
    });

    it('an abort removes a queued waiter and rejects it with 499', async () => {
        const limiter = createLimiter({ maxConcurrent: 1, maxQueue: 2 });
        const holder = await limiter.acquire();
        const controller = new AbortController();
        const waiting = limiter.acquire(controller.signal);
        assert.equal(limiter.stats().queued, 1);
        controller.abort();
        await assert.rejects(waiting, (error) => error.status === 499 && error.code === 'cancelled');
        assert.equal(limiter.stats().queued, 0);
        holder();
        assert.equal(limiter.stats().active, 0);
    });

    it('rejects immediately for an already-aborted signal', async () => {
        const limiter = createLimiter({ maxConcurrent: 1, maxQueue: 1 });
        await assert.rejects(limiter.acquire(AbortSignal.abort()), { status: 499 });
        assert.equal(limiter.stats().active, 0);
    });

    it('weights requests and clamps the weight to [1, maxConcurrent]', async () => {
        const limiter = createLimiter({ maxConcurrent: 3, maxQueue: 5 });
        const heavy = await limiter.acquire(undefined, 2);
        assert.equal(limiter.stats().active, 2);
        const light = await limiter.acquire(undefined, 0);
        assert.equal(limiter.stats().active, 3, 'weight 0 counts as 1');
        heavy();
        light();
        const huge = await limiter.acquire(undefined, 99);
        assert.equal(limiter.stats().active, 3, 'weight is clamped to maxConcurrent');
        huge();
        const odd = await limiter.acquire(undefined, Number.NaN);
        assert.equal(limiter.stats().active, 1);
        odd();
    });

    it('is strictly FIFO: a light request queues behind a waiting heavy one', async () => {
        const limiter = createLimiter({ maxConcurrent: 2, maxQueue: 5 });
        const first = await limiter.acquire();
        const order = [];
        const heavy = limiter.acquire(undefined, 2).then((release) => { order.push('heavy'); return release; });
        const light = limiter.acquire(undefined, 1).then((release) => { order.push('light'); return release; });
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(order, [], 'light waits although one slot is free');
        assert.equal(limiter.stats().queued, 2);
        first();
        const releaseHeavy = await heavy;
        assert.deepEqual(order, ['heavy']);
        releaseHeavy();
        (await light)();
        assert.deepEqual(order, ['heavy', 'light']);
        assert.equal(limiter.stats().active, 0);
    });

    it('aborting a queued waiter lets the next one through', async () => {
        const limiter = createLimiter({ maxConcurrent: 2, maxQueue: 5 });
        const first = await limiter.acquire();
        const controller = new AbortController();
        const heavy = limiter.acquire(controller.signal, 2);
        const light = limiter.acquire(undefined, 1);
        controller.abort();
        await assert.rejects(heavy, { status: 499 });
        const releaseLight = await light;
        assert.equal(limiter.stats().active, 2);
        releaseLight();
        first();
    });

    it('a queued waiter granted a slot is released by its own signal', async () => {
        const limiter = createLimiter({ maxConcurrent: 1, maxQueue: 1 });
        const first = await limiter.acquire();
        const controller = new AbortController();
        const pending = limiter.acquire(controller.signal);
        first();
        await pending;
        assert.equal(limiter.stats().active, 1);
        controller.abort();
        assert.equal(limiter.stats().active, 0);
    });
});

describe('slotMiddleware', () => {
    const setup = (options) => {
        const limiter = createLimiter({ maxConcurrent: 1, maxQueue: 0, ...options });
        const req = {};
        const res = fakeRes();
        let called = false;
        slotMiddleware({ limiter, timeoutMs: options?.timeoutMs ?? 5000 })(req, res, () => { called = true; });
        assert.ok(called);
        return { limiter, req, res };
    };

    it('holds the requested number of slots', async () => {
        const { limiter, req } = setup({ maxConcurrent: 4 });
        const active = await req.withSlot(async () => limiter.stats().active, 3);
        assert.equal(active, 3);
        assert.equal(limiter.stats().active, 0);
    });

    it('runs work inside a slot and releases it afterwards', async () => {
        const { limiter, req } = setup();
        const value = await req.withSlot(async (signal) => {
            assert.equal(signal.aborted, false);
            assert.equal(limiter.stats().active, 1);
            return 42;
        });
        assert.equal(value, 42);
        assert.equal(limiter.stats().active, 0);
    });

    it('releases the slot when the work throws', async () => {
        const { limiter, req } = setup();
        await assert.rejects(req.withSlot(async () => { throw new Error('nope'); }), /nope/);
        assert.equal(limiter.stats().active, 0);
    });

    it('aborts with 504 when the timeout elapses', async () => {
        const { limiter, req } = setup({ timeoutMs: 20 });
        const reason = await req.withSlot((signal) => new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve(signal.reason));
        }));
        assert.equal(reason.status, 504);
        assert.equal(reason.code, 'timeout');
        assert.equal(limiter.stats().active, 0);
    });

    it('aborts with 499 when the client disconnects', async () => {
        const { limiter, req, res } = setup();
        const work = req.withSlot((signal) => new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve(signal.reason));
            setImmediate(() => res.emit('close'));
        }));
        const reason = await work;
        assert.equal(reason.status, 499);
        assert.equal(limiter.stats().active, 0);
        assert.equal(res.listenerCount('close'), 0);
    });

    it('does not abort when the response already finished', async () => {
        const { req, res } = setup();
        const aborted = await req.withSlot(async (signal) => {
            res.writableFinished = true;
            res.emit('close');
            return signal.aborted;
        });
        assert.equal(aborted, false);
    });
});

describe('metrics', () => {
    it('counts requests, statuses and failures', () => {
        const metrics = createMetrics();
        const res = fakeRes();
        let nextCalled = false;
        metrics.middleware({}, res, () => { nextCalled = true; });
        assert.ok(nextCalled);
        res.statusCode = 201;
        res.emit('finish');
        metrics.authFailure();
        metrics.rateLimited();
        metrics.rateLimited();
        const snapshot = metrics.snapshot({ extra: true });
        assert.equal(snapshot.requests, 1);
        assert.deepEqual(snapshot.responses_by_status, { 201: 1 });
        assert.equal(snapshot.auth_failures, 1);
        assert.equal(snapshot.rate_limited, 2);
        assert.equal(snapshot.extra, true);
        assert.equal(typeof snapshot.uptime_s, 'number');
        assert.equal(createMetrics().snapshot().requests, 0);
    });
});

describe('authMiddleware', () => {
    const failures = [];
    const auth = authMiddleware({ apiKeys: [KEY, 'second-key-abcdefghij'], allowNoAuth: false, onFailure: () => failures.push(1) });

    it('accepts a matching bearer key (any configured key, case-insensitive scheme)', () => {
        const first = fakeReq({ headers: { authorization: `Bearer ${KEY}` } });
        assert.ok(run(auth, first).nextCalled);
        const second = fakeReq({ headers: { authorization: 'bearer   second-key-abcdefghij ' } });
        assert.ok(run(auth, second).nextCalled);
        const expected = crypto.createHash('sha256').update(KEY).digest('hex').slice(0, 32);
        assert.equal(first.clientId, expected, 'client id is an opaque hash of the key');
        assert.match(second.clientId, /^[0-9a-f]{32}$/);
        assert.notEqual(first.clientId, second.clientId);
    });

    it('marks unauthenticated and public requests as anonymous', () => {
        const health = fakeReq({ path: '/health', headers: { authorization: `Bearer ${KEY}` } });
        run(auth, health);
        assert.equal(health.clientId, 'anonymous');
        const open = fakeReq();
        run(authMiddleware({ apiKeys: [KEY], allowNoAuth: true }), open);
        assert.equal(open.clientId, 'anonymous');
        const rejected = fakeReq();
        run(auth, rejected);
        assert.equal(rejected.clientId, 'anonymous');
    });

    it('rejects a missing key with 401 and WWW-Authenticate', () => {
        const before = failures.length;
        const { res, nextCalled } = run(auth, fakeReq());
        assert.equal(nextCalled, false);
        assert.equal(res.statusCode, 401);
        assert.equal(res.headers['WWW-Authenticate'], 'Bearer');
        assert.match(res.body.error.message, /Missing API key/);
        assert.equal(res.body.error.code, 'invalid_api_key');
        assert.equal(res.body.error.type, 'authentication_error');
        assert.equal(failures.length, before + 1);
    });

    it('rejects a wrong key and non-bearer schemes', () => {
        const wrong = run(auth, fakeReq({ headers: { authorization: 'Bearer wrong-key-000000000000' } }));
        assert.equal(wrong.res.statusCode, 401);
        assert.match(wrong.res.body.error.message, /Incorrect API key/);
        const basic = run(auth, fakeReq({ headers: { authorization: `Basic ${KEY}` } }));
        assert.equal(basic.res.statusCode, 401);
        assert.match(basic.res.body.error.message, /Missing API key/);
    });

    it('leaves /health, /ready and CORS preflights public', () => {
        assert.ok(run(auth, fakeReq({ path: '/health' })).nextCalled);
        assert.ok(run(auth, fakeReq({ path: '/ready' })).nextCalled);
        assert.ok(run(auth, fakeReq({ method: 'OPTIONS' })).nextCalled);
    });

    it('allowNoAuth lets everything through', () => {
        const open = authMiddleware({ apiKeys: [], allowNoAuth: true });
        assert.ok(run(open, fakeReq()).nextCalled);
    });

    it('works without an onFailure callback', () => {
        const bare = authMiddleware({ apiKeys: [KEY], allowNoAuth: false });
        assert.equal(run(bare, fakeReq()).res.statusCode, 401);
    });
});

describe('rateLimitMiddleware', () => {
    it('allows a burst of perMinute requests then answers 429 with Retry-After', (t) => {
        let limited = 0;
        const limiter = rateLimitMiddleware({ perMinute: 2, onLimited: () => { limited += 1; } });
        t.after(() => limiter.close());
        const req = fakeReq({ ip: '10.0.0.1' });
        assert.ok(run(limiter, req).nextCalled);
        assert.ok(run(limiter, req).nextCalled);
        const { res, nextCalled } = run(limiter, req);
        assert.equal(nextCalled, false);
        assert.equal(res.statusCode, 429);
        assert.equal(res.body.error.code, 'rate_limit_exceeded');
        assert.ok(Number(res.headers['Retry-After']) >= 1);
        assert.equal(limited, 1);
        assert.ok(run(limiter, fakeReq({ ip: '10.0.0.2' })).nextCalled, 'buckets are per client');
        assert.ok(run(limiter, fakeReq({ ip: '10.0.0.1', path: '/health' })).nextCalled, 'health is exempt');
    });

    it('refills over time', (t) => {
        let now = 1_000_000;
        t.mock.method(Date, 'now', () => now);
        const limiter = rateLimitMiddleware({ perMinute: 1 });
        t.after(() => limiter.close());
        const req = fakeReq({ ip: '10.0.0.3' });
        assert.ok(run(limiter, req).nextCalled);
        assert.equal(run(limiter, req).nextCalled, false);
        now += 60_000;
        assert.ok(run(limiter, req).nextCalled);
    });

    it('is disabled with perMinute 0', (t) => {
        const limiter = rateLimitMiddleware({ perMinute: 0 });
        t.after(() => limiter.close());
        for (let i = 0; i < 5; i += 1) assert.ok(run(limiter, fakeReq()).nextCalled);
    });

    it('evicts the oldest client when the table is full', (t) => {
        const limiter = rateLimitMiddleware({ perMinute: 1, maxClients: 1 });
        t.after(() => limiter.close());
        const a = fakeReq({ ip: 'a' });
        assert.ok(run(limiter, a).nextCalled);
        assert.equal(run(limiter, a).nextCalled, false);
        assert.ok(run(limiter, fakeReq({ ip: 'b' })).nextCalled);
        assert.ok(run(limiter, a).nextCalled, 'a was evicted and starts with a fresh bucket');
    });

    it('falls back to the socket address', (t) => {
        const limiter = rateLimitMiddleware({ perMinute: 1 });
        t.after(() => limiter.close());
        const req = { path: '/x', method: 'GET', headers: {}, socket: { remoteAddress: '192.0.2.1' } };
        assert.ok(run(limiter, req).nextCalled);
        assert.equal(run(limiter, req).nextCalled, false);
        const anonymous = { path: '/x', method: 'GET', headers: {} };
        assert.ok(run(limiter, anonymous).nextCalled);
    });
});

describe('requestId / securityHeaders', () => {
    it('echoes a sane client id', () => {
        const req = fakeReq({ headers: { 'x-request-id': 'client-id.123_abc' } });
        const { res, nextCalled } = run(requestId, req);
        assert.ok(nextCalled);
        assert.equal(req.id, 'client-id.123_abc');
        assert.equal(res.headers['x-request-id'], 'client-id.123_abc');
    });

    it('replaces unsafe or oversized ids', () => {
        for (const incoming of ['bad id\r\nx', 'x'.repeat(65), '<script>', undefined]) {
            const req = fakeReq({ headers: incoming === undefined ? {} : { 'x-request-id': incoming } });
            const { res } = run(requestId, req);
            assert.match(req.id, /^req_[0-9a-f]{24}$/);
            assert.equal(res.headers['x-request-id'], req.id);
        }
    });

    it('sets defensive headers', () => {
        const { res, nextCalled } = run(securityHeaders, fakeReq());
        assert.ok(nextCalled);
        assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
        assert.equal(res.headers['X-Frame-Options'], 'DENY');
        assert.equal(res.headers['Cache-Control'], 'no-store');
        assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
    });
});
