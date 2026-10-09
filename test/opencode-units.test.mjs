import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog, toOpenAIModel } from '../src/opencode/catalog.js';
import { BackendError, backendOrigin, basicAuthHeader, createOpencodeClient } from '../src/opencode/client.js';
import { mapBackendError, mapModelError } from '../src/opencode/model-errors.js';
import { readSseFrames } from '../src/opencode/sse-reader.js';
import { ApiError } from '../src/server/errors.js';
import { createLogger, silentLogger } from '../src/logger.js';

describe('mapModelError', () => {
    it('turns truncation and filtering into finish reasons', () => {
        assert.deepEqual(mapModelError({ name: 'MessageOutputLengthError' }), { finish: 'length' });
        assert.deepEqual(mapModelError({ name: 'ContentFilterError' }), { finish: 'content_filter' });
    });

    it('maps named errors to API errors', () => {
        const cases = [
            [{ name: 'MessageAbortedError' }, 499, 'cancelled'],
            [{ name: 'ContextOverflowError', data: { message: 'too   long\n' } }, 400, 'context_length_exceeded'],
            [{ name: 'StructuredOutputError' }, 502, 'structured_output_failed'],
            [{ name: 'ProviderAuthError', message: 'no key' }, 502, 'upstream_auth_failed'],
            [{ name: 'SomethingNew', data: { message: 'weird' } }, 502, 'upstream_error'],
            [null, 502, 'upstream_error'],
        ];
        for (const [error, status, code] of cases) {
            const mapped = mapModelError(error).throw;
            assert.ok(mapped instanceof ApiError);
            assert.equal(mapped.status, status, JSON.stringify(error));
            assert.equal(mapped.code, code);
        }
        assert.match(mapModelError({ name: 'ContextOverflowError', data: { message: 'too   long\n' } }).throw.message, /too long$/);
        assert.match(mapModelError(null).throw.message, /UnknownError/);
        assert.equal(mapModelError({ name: 'X', message: 'y'.repeat(1000) }).throw.message.length < 500, true);
    });

    it('maps upstream API errors by status', () => {
        const api = (statusCode, extra = {}) => mapModelError({ name: 'APIError', data: { statusCode, message: 'upstream said no', ...extra } }).throw;
        const limited = api(429, { responseHeaders: { 'retry-after': '12.2' } });
        assert.equal(limited.status, 429);
        assert.equal(limited.code, 'upstream_rate_limited');
        assert.equal(limited.retryAfter, 13);
        assert.equal(api(429, { responseHeaders: { 'Retry-After': 'soon' } }).retryAfter, 30);
        assert.equal(api(429, { responseHeaders: { 'retry-after': '99999' } }).retryAfter, 30);
        assert.equal(api(429).retryAfter, 30);
        for (const status of [400, 413, 422]) assert.equal(api(status).code, 'upstream_rejected');
        for (const status of [401, 403]) assert.equal(api(status).code, 'upstream_refused');
        assert.equal(api(500).code, 'upstream_error');
        assert.equal(api(undefined).status, 502);
    });
});

describe('mapBackendError', () => {
    it('passes through API and abort errors', () => {
        const api = new ApiError(404, 'x');
        assert.equal(mapBackendError(api), api);
        const abort = Object.assign(new Error('a'), { name: 'AbortError' });
        assert.equal(mapBackendError(abort), abort);
        const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
        assert.equal(mapBackendError(timeout), timeout);
    });

    it('maps 400s to backend_rejected and everything else to 503', () => {
        const objectBody = mapBackendError(new BackendError('bad', { status: 400, body: { error: 'bad model' } }));
        assert.equal(objectBody.status, 400);
        assert.equal(objectBody.code, 'backend_rejected');
        assert.match(objectBody.message, /bad model/);
        const stringBody = mapBackendError(new BackendError('bad', { status: 400, body: 'plain' }));
        assert.match(stringBody.message, /plain$/);
        assert.equal(mapBackendError(new BackendError('bad', { status: 400 })).status, 400);
        const down = mapBackendError(new BackendError('down', { status: 500 }));
        assert.equal(down.status, 503);
        assert.equal(down.code, 'backend_unavailable');
        assert.equal(down.retryAfter, 2);
        assert.equal(mapBackendError(new Error('x')).status, 503);
    });
});

const PROVIDERS = {
    providers: [
        {
            id: 'opencode',
            models: {
                zeta: { name: 'Zeta', release_date: '2025-02-03', capabilities: { input: { text: true, image: true, pdf: true }, reasoning: true }, variants: { high: {}, max: {} }, limit: { context: 1000, output: 100 } },
                alpha: { id: 'alpha-1' },
                gone: { status: 'deprecated' },
                broken: null,
                silent: { capabilities: { input: { text: false, audio: true } } },
            },
        },
        { id: 'acme', models: { turbo: { name: 'Turbo' } } },
        { models: { orphan: {} } },
        null,
    ],
};

function catalogWith(responses, logger = silentLogger) {
    let calls = 0;
    const client = {
        async providers() {
            const next = responses[Math.min(calls, responses.length - 1)];
            calls += 1;
            if (next instanceof Error) throw next;
            return next;
        },
    };
    return { catalog: createCatalog({ getClient: () => client, logger }), calls: () => calls };
}

describe('catalog', () => {
    it('normalizes and sorts models', async () => {
        const { catalog } = catalogWith([PROVIDERS]);
        const models = await catalog.list();
        assert.deepEqual(models.map((m) => m.id), ['acme/turbo', 'alpha-1', 'silent', 'zeta']);
        const zeta = models.find((m) => m.id === 'zeta');
        assert.deepEqual({ ...zeta, input: [...zeta.input], variants: [...zeta.variants] }, {
            id: 'zeta', providerID: 'opencode', modelID: 'zeta', name: 'Zeta', created: Math.floor(Date.parse('2025-02-03') / 1000),
            input: ['text', 'image', 'pdf'], reasoning: true, variants: ['high', 'max'], contextWindow: 1000, maxOutputTokens: 100,
        });
        const alpha = models.find((m) => m.id === 'alpha-1');
        assert.deepEqual([...alpha.input], ['text']);
        assert.equal(alpha.created, 0);
        assert.equal(alpha.name, 'alpha-1');
        assert.equal(alpha.contextWindow, null);
        assert.deepEqual([...models.find((m) => m.id === 'silent').input], ['audio']);
        assert.equal(models.find((m) => m.id === 'acme/turbo').providerID, 'acme');
        assert.ok(Object.isFrozen(zeta));
    });

    it('resolves bare, opencode/-prefixed and provider/model ids', async () => {
        const { catalog } = catalogWith([PROVIDERS]);
        assert.equal((await catalog.resolve('zeta')).id, 'zeta');
        assert.equal((await catalog.resolve(' opencode/zeta ')).id, 'zeta');
        assert.equal((await catalog.resolve('acme/turbo')).modelID, 'turbo');
    });

    it('answers 404 with a hint listing available models', async () => {
        const { catalog } = catalogWith([PROVIDERS]);
        await assert.rejects(catalog.resolve('nope'), (error) => error.status === 404 && error.code === 'model_not_found'
            && error.param === 'model' && /Available: acme\/turbo, alpha-1, silent, zeta \(see GET/.test(error.message));
        await assert.rejects(catalog.resolve(undefined), { status: 404 });
    });

    it('truncates long hints', async () => {
        const many = { providers: [{ id: 'opencode', models: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`m${String(i).padStart(2, '0')}`, {}])) }] };
        const { catalog } = catalogWith([many]);
        await assert.rejects(catalog.resolve('x'), (error) => /m11, \.\.\. \(see/.test(error.message) && !/m12/.test(error.message));
    });

    it('caches the list and refreshes after invalidate', async () => {
        const { catalog, calls } = catalogWith([PROVIDERS, { providers: [] }]);
        await Promise.all([catalog.list(), catalog.list()]);
        assert.equal(calls(), 1, 'concurrent loads share one request');
        await catalog.list();
        assert.equal(calls(), 1);
        catalog.invalidate();
        assert.deepEqual(await catalog.list(), []);
        assert.equal(calls(), 2);
    });

    it('serves the stale list when a refresh fails', async () => {
        const warnings = [];
        const logger = createLogger({ level: 'warn', sink: { out: () => {}, err: (line) => warnings.push(line) } });
        const { catalog } = catalogWith([PROVIDERS, new Error('backend down')], logger);
        assert.equal((await catalog.list()).length, 4);
        catalog.invalidate();
        assert.equal((await catalog.list()).length, 4);
        assert.match(warnings[0], /serving the cached list/);
    });

    it('answers 503 when the list was never loaded', async () => {
        const { catalog } = catalogWith([new Error('backend down')]);
        await assert.rejects(catalog.list(), (error) => error.status === 503 && error.code === 'backend_unavailable' && error.retryAfter === 2);
    });

    it('treats a malformed payload as an empty catalog', async () => {
        const { catalog } = catalogWith([{ providers: 'nope' }]);
        assert.deepEqual(await catalog.list(), []);
    });

    it('builds the public model object', () => {
        assert.deepEqual(toOpenAIModel({ id: 'zeta', created: 5, providerID: 'opencode', extra: 1 }), { id: 'zeta', object: 'model', created: 5, owned_by: 'opencode' });
    });
});

async function* chunks(...parts) {
    for (const part of parts) yield typeof part === 'string' ? new TextEncoder().encode(part) : part;
}

async function collect(iterable) {
    const out = [];
    for await (const item of iterable) out.push(item);
    return out;
}

describe('readSseFrames', () => {
    it('parses frames split anywhere, with LF or CRLF', async () => {
        const frames = await collect(readSseFrames(chunks('data: {"a":', '1}\n', '\nevent: named\r\ndata: x\r\n\r\n', ': comment\n\n', 'data:tight\n\n')));
        assert.deepEqual(frames, [
            { event: '', data: '{"a":1}' },
            { event: 'named', data: 'x' },
            { event: '', data: 'tight' },
        ]);
    });

    it('joins multi-line data and flushes an unterminated tail', async () => {
        const frames = await collect(readSseFrames(chunks('data: line1\ndata: line2\n\ndata: tail')));
        assert.deepEqual(frames, [{ event: '', data: 'line1\nline2' }, { event: '', data: 'tail' }]);
    });

    it('decodes multi-byte characters split across chunks', async () => {
        const bytes = new TextEncoder().encode('data: héllo €\n\n');
        const frames = await collect(readSseFrames(chunks(bytes.slice(0, 8), bytes.slice(8, 14), bytes.slice(14))));
        assert.deepEqual(frames, [{ event: '', data: 'héllo €' }]);
    });

    it('refuses frames over the size limit', async () => {
        const huge = 'x'.repeat(16 * 1024 * 1024 + 1);
        await assert.rejects(collect(readSseFrames(chunks(`data: ${huge}`))), /size limit/);
    });

    it('yields nothing for an empty stream', async () => {
        assert.deepEqual(await collect(readSseFrames(chunks())), []);
    });
});

function fakeFetch(handler) {
    const calls = [];
    const impl = async (url, init) => {
        calls.push({ url, init });
        return handler(url, init);
    };
    return { impl, calls };
}

describe('opencode client', () => {
    it('builds a basic auth header only when a password is set', () => {
        assert.equal(basicAuthHeader('u', ''), null);
        assert.equal(basicAuthHeader('', 'pw'), `Basic ${Buffer.from('opencode:pw').toString('base64')}`);
        assert.equal(basicAuthHeader('me', 'pw'), `Basic ${Buffer.from('me:pw').toString('base64')}`);
    });

    it('sends JSON requests to the documented paths', async () => {
        const fetch = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
        const client = createOpencodeClient({ baseUrl: 'http://127.0.0.1:1/', username: 'opencode', password: 'pw', fetchImpl: fetch.impl });
        assert.equal(client.baseUrl, 'http://127.0.0.1:1');
        await client.health();
        await client.providers();
        await client.agents();
        await client.createSession();
        await client.deleteSession('s/1');
        await client.abortSession('s1');
        await client.messages('s1');
        await client.prompt('s1', { parts: [] });
        await client.replyPermission('p1', 'reject', 'msg');
        await client.replyPermission('p2', 'once');
        await client.rejectQuestion('q1');
        await client.pendingPermissions();
        await client.pendingQuestions();
        const seen = fetch.calls.map((c) => `${c.init.method} ${c.url.replace('http://127.0.0.1:1', '')}`);
        assert.deepEqual(seen, [
            'GET /global/health', 'GET /config/providers', 'GET /agent', 'POST /session', 'DELETE /session/s%2F1',
            'POST /session/s1/abort', 'GET /session/s1/message', 'POST /session/s1/message', 'POST /permission/p1/reply',
            'POST /permission/p2/reply', 'POST /question/q1/reject', 'GET /permission', 'GET /question',
        ]);
        const create = fetch.calls[3].init;
        assert.equal(create.headers.authorization, basicAuthHeader('opencode', 'pw'));
        assert.equal(create.headers['content-type'], 'application/json');
        assert.deepEqual(JSON.parse(create.body), { title: 'openai-gateway' });
        assert.equal(create.redirect, 'error');
        assert.deepEqual(JSON.parse(fetch.calls[8].init.body), { reply: 'reject', message: 'msg' });
        assert.deepEqual(JSON.parse(fetch.calls[9].init.body), { reply: 'once' });
        assert.equal(fetch.calls[0].init.headers['content-type'], undefined);
        assert.ok(fetch.calls[0].init.signal, 'health has a timeout signal');
    });

    it('returns text bodies and null for empty bodies', async () => {
        const bodies = ['not json', ''];
        const fetch = fakeFetch(() => new Response(bodies.shift(), { status: 200 }));
        const client = createOpencodeClient({ baseUrl: 'http://x', fetchImpl: fetch.impl });
        assert.equal(await client.providers(), 'not json');
        assert.equal(await client.providers(), null);
        assert.equal(fetch.calls[0].init.headers.authorization, undefined);
    });

    it('raises BackendError with status and body on HTTP errors', async () => {
        const fetch = fakeFetch(() => new Response(JSON.stringify({ error: 'bad' }), { status: 400 }));
        const client = createOpencodeClient({ baseUrl: 'http://x', fetchImpl: fetch.impl });
        await assert.rejects(client.createSession(), (error) => error instanceof BackendError && error.status === 400 && error.body.error === 'bad');
    });

    it('wraps network failures but passes aborts through', async () => {
        const network = createOpencodeClient({
            baseUrl: 'http://x',
            fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); },
        });
        await assert.rejects(network.health(), (error) => error instanceof BackendError && /unreachable at http:\/\/x: ECONNREFUSED/.test(error.message));
        const aborting = createOpencodeClient({
            baseUrl: 'http://x',
            fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
        });
        await assert.rejects(aborting.prompt('s', {}, { signal: AbortSignal.abort() }), { name: 'AbortError' });
    });

    it('names the backend by scheme, host and port only in errors', async () => {
        const client = createOpencodeClient({
            baseUrl: 'https://user:s3cret-pw@opencode.example:8443/prefix-token/?key=s3cret-key',
            fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); },
        });
        await assert.rejects(client.health(), (error) => {
            assert.equal(error.message, 'OpenCode backend unreachable at https://opencode.example:8443: ECONNREFUSED');
            return true;
        });
        assert.equal(backendOrigin('http://127.0.0.1:4096/'), 'http://127.0.0.1:4096');
        assert.equal(backendOrigin('not a url'), '(invalid URL)');
    });

    it('opens the event stream and reports failures', async () => {
        const ok = createOpencodeClient({ baseUrl: 'http://x', fetchImpl: async (url, init) => {
            assert.equal(init.headers.accept, 'text/event-stream');
            return new Response('data: {}\n\n', { status: 200 });
        } });
        const response = await ok.openEvents(new AbortController().signal);
        assert.ok(response.body);
        const bad = createOpencodeClient({ baseUrl: 'http://x', fetchImpl: async () => new Response('no', { status: 401 }) });
        await assert.rejects(bad.openEvents(), (error) => error instanceof BackendError && error.status === 401);
    });
});
