import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOpencodeClientV2 } from '../src/opencode/client-v2.js';
import { createCatalog } from '../src/opencode/catalog.js';
import { probeBackend } from '../src/opencode/detect.js';
import { createAttachedBackend } from '../src/opencode/backend.js';
import { adaptEvent, errorFromV2, messageFromV2, providersFromModels } from '../src/opencode/v2-convert.js';
import { mapModelError } from '../src/opencode/model-errors.js';
import { silentLogger } from '../src/logger.js';
import { startFakeOpencode } from './helpers/fake-opencode.mjs';
import { FAKE_V2_VERSION, startFakeOpencodeV2 } from './helpers/fake-opencode-v2.mjs';

describe('OpenCode 2 detection', () => {
    let v1;
    let v2;
    before(async () => { [v1, v2] = await Promise.all([startFakeOpencode(), startFakeOpencodeV2()]); });
    after(async () => { await Promise.all([v1.close(), v2.close()]); });

    it('tells the two API generations apart by how the server answers', async () => {
        assert.equal((await probeBackend({ baseUrl: v1.url })).client.api, 'v1');
        const found = await probeBackend({ baseUrl: v2.url });
        assert.equal(found.client.api, 'v2');
        assert.equal(found.health.version, FAKE_V2_VERSION);
    });

    it('reports an unreachable server instead of guessing a generation', async () => {
        await assert.rejects(probeBackend({ baseUrl: 'http://127.0.0.1:1' }), /unreachable/);
    });

    it('lets an attached backend use whichever API the server speaks', async () => {
        const backend = createAttachedBackend({ url: v2.url, username: 'opencode', password: '', logger: silentLogger });
        await backend.start();
        assert.equal(backend.getClient().api, 'v2');
        assert.equal(backend.version(), FAKE_V2_VERSION);
        await backend.stop();
    });
});

describe('OpenCode 2 client', () => {
    let fake;
    let client;
    before(async () => {
        fake = await startFakeOpencodeV2();
        client = createOpencodeClientV2({ baseUrl: fake.url });
    });
    after(async () => { await fake.close(); });

    const callsTo = (method, path) => fake.calls.filter((call) => call.method === method && call.path.startsWith(path));

    it('lists models in the catalog the gateway already understands', async () => {
        const catalog = createCatalog({ getClient: () => client, logger: silentLogger });
        const models = await catalog.list();
        assert.deepEqual(models.map((model) => model.id), ['big-pickle']);
        const [model] = models;
        assert.deepEqual(model.input, ['text', 'image']);
        assert.deepEqual(model.variants, ['high', 'low']);
        assert.equal(model.reasoning, true);
        assert.equal(model.created, Date.parse('2025-10-17T00:00:00Z') / 1000);
        assert.equal(model.contextWindow, 200000);
    });

    it('creates sessions that ask before every action and deny execute and browser outright', async () => {
        const session = await client.createSession();
        assert.match(session.id, /^ses_/);
        const call = callsTo('POST', '/api/session').find((entry) => entry.path === '/api/session');
        assert.deepEqual(call.body.permissions, [
            { action: '*', resource: '*', effect: 'ask' },
            { action: 'execute', resource: '*', effect: 'deny' },
            { action: 'browser', resource: '*', effect: 'deny' },
        ]);
    });

    it('refuses attachments that are not inlined, so OpenCode never resolves a URL itself', async () => {
        for (const url of ['file:///etc/passwd', 'https://example.com/a.png', 'C:\\secret.txt']) {
            await assert.rejects(client.prompt('ses_1', { parts: [{ type: 'file', url, mime: 'image/png' }] }), /inlined as data/);
        }
    });

    it('sends a system prompt too large for an instruction entry along with the prompt', async () => {
        fake.calls.length = 0;
        const system = 'x'.repeat(210 * 1024);
        await client.prompt('ses_1', { system, parts: [{ type: 'text', text: 'question' }] });
        assert.equal(callsTo('PUT', '/api/experimental/session/ses_1/instructions').length, 0);
        assert.equal(callsTo('POST', '/api/session/ses_1/prompt')[0].body.text, `${system}\n\nquestion`);
    });

    it('measures the instruction by its JSON size, where control characters grow six-fold', async () => {
        fake.calls.length = 0;
        await client.prompt('ses_1', { system: '\u0001'.repeat(40 * 1024), parts: [{ type: 'text', text: 'q' }] });
        assert.equal(callsTo('PUT', '/api/experimental/session/ses_1/instructions').length, 0);
    });

    it('does not remember a failed agent lookup', async () => {
        const fresh = createOpencodeClientV2({ baseUrl: fake.url });
        fake.state.failAgents = true;
        fake.calls.length = 0;
        await assert.rejects(fresh.prompt('ses_1', { agent: 'plan', parts: [{ type: 'text', text: 'x' }] }), /failed with HTTP 500/);
        assert.equal(callsTo('POST', '/api/session/ses_1/agent').length, 0);
        assert.equal(callsTo('POST', '/api/session/ses_1/prompt').length, 0);
        fake.state.failAgents = false;
        fake.state.agents = [{ id: 'plan' }];
        try {
            await fresh.prompt('ses_1', { agent: 'plan', parts: [{ type: 'text', text: 'x' }] });
            assert.equal(callsTo('POST', '/api/session/ses_1/agent').length, 1);
        } finally {
            fake.state.agents = [{ id: 'plan' }];
        }
    });

    it('treats the web-app fallback page as a failure, not as success', async () => {
        const stale = createOpencodeClientV2({ baseUrl: fake.url, fetchImpl: (url, init) => fetch(String(url).replace('/api/', '/nope/'), init) });
        await assert.rejects(stale.replyPermission('per_1', 'reject', '', 'ses_1'), /did not answer with JSON/);
        await assert.rejects(stale.createSession(), /did not answer with JSON/);
        await assert.rejects(stale.health(), /did not answer with JSON/);
    });

    it('fails fast when the prompt is not acknowledged with an id', async () => {
        fake.state.promptReply = {};
        try {
            await assert.rejects(client.prompt('ses_1', { parts: [{ type: 'text', text: 'x' }] }), /did not return a message id/);
        } finally {
            fake.state.promptReply = undefined;
        }
    });

    it('reports a turn that went idle without any answer instead of waiting for one', async () => {
        fake.state.noAnswer = 'failed';
        try {
            const { info, parts } = await client.prompt('ses_1', { parts: [{ type: 'text', text: 'x' }] });
            assert.equal(info.error.name, 'UnknownError');
            assert.match(info.error.data.message, /failed before the model answered/);
            assert.deepEqual(parts, []);
        } finally {
            fake.state.noAnswer = undefined;
        }
    });

    it('stops polling when the caller gives up', async () => {
        fake.state.pollsBeforeIdle = Infinity;
        try {
            const controller = new AbortController();
            setTimeout(() => controller.abort(new Error('gave up')), 400);
            await assert.rejects(client.prompt('ses_1', { parts: [{ type: 'text', text: 'x' }] }, { signal: controller.signal }), /gave up/);
        } finally {
            fake.state.pollsBeforeIdle = 0;
        }
    });

    it('applies model, system prompt and attachments, then returns the final assistant message', async () => {
        fake.calls.length = 0;
        const result = await client.prompt('ses_1', {
            model: { providerID: 'opencode', modelID: 'big-pickle' },
            variant: 'high',
            agent: 'plan',
            system: 'Be brief.',
            format: { type: 'json_schema', schema: { type: 'object' } },
            parts: [
                { type: 'text', text: 'first' },
                { type: 'text', text: 'second' },
                { type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA', filename: 'dot.png' },
            ],
        });

        assert.deepEqual(callsTo('POST', '/api/session/ses_1/model')[0].body, { model: { providerID: 'opencode', id: 'big-pickle', variant: 'high' } });
        assert.equal(callsTo('POST', '/api/session/ses_1/agent').length, 1);
        const instruction = callsTo('PUT', '/api/experimental/session/ses_1/instructions/entries/gateway')[0].body.value;
        assert.match(instruction, /^Be brief\.\n\nReply with only JSON matching this schema: \{"type":"object"\}$/);
        assert.deepEqual(callsTo('POST', '/api/session/ses_1/prompt')[0].body, {
            text: 'first\n\nsecond',
            files: [{ uri: 'data:image/png;base64,AAAA', name: 'dot.png' }],
        });

        assert.equal(result.info.id, 'msg_a1');
        assert.equal(result.info.role, 'assistant');
        assert.equal(result.info.tokens.cache.read, 3);
        assert.deepEqual(result.parts, [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'hello' }]);
    });

    it('selects the requested agent when the server has it', async () => {
        fake.state.agents = [{ id: 'plan', name: 'plan' }];
        const fresh = createOpencodeClientV2({ baseUrl: fake.url });
        fake.calls.length = 0;
        await fresh.prompt('ses_1', { agent: 'plan', parts: [{ type: 'text', text: 'x' }] });
        assert.deepEqual(callsTo('POST', '/api/session/ses_1/agent')[0].body, { agent: 'plan' });
        fake.state.agents = [];
    });

    it('polls for the finished turn when the wait route is missing or returns early', async () => {
        fake.state.waitStatus = 404;
        fake.state.pollsBeforeIdle = 2;
        try {
            const result = await client.prompt('ses_1', { parts: [{ type: 'text', text: 'x' }] });
            assert.equal(result.info.id, 'msg_a1');
        } finally {
            fake.state.waitStatus = 204;
            fake.state.pollsBeforeIdle = 0;
        }
    });

    it('turns a failed assistant message into the error the runner maps', async () => {
        const original = fake.state.assistant;
        fake.state.assistant = { id: 'msg_a1', type: 'assistant', content: [], finish: 'error', error: { type: 'provider.auth', message: 'free tier', status: 403 } };
        try {
            const { info } = await client.prompt('ses_1', { parts: [{ type: 'text', text: 'x' }] });
            assert.deepEqual(info.error, { name: 'ProviderAuthError', data: { message: 'free tier', statusCode: 403, type: 'provider.auth' } });
            assert.equal(mapModelError(info.error).throw.code, 'upstream_auth_failed');
        } finally {
            fake.state.assistant = original;
        }
    });

    it('answers permission requests and forms per session', async () => {
        fake.calls.length = 0;
        await client.replyPermission('per_1', 'reject', 'no tools', 'ses_1');
        await client.rejectQuestion('frm_1', 'ses_1');
        assert.deepEqual(callsTo('POST', '/api/session/ses_1/permission/per_1/reply')[0].body, { decision: 'reject', message: 'no tools' });
        assert.equal(callsTo('DELETE', '/api/session/ses_1/form/frm_1').length, 1);
        assert.deepEqual(await client.pendingPermissions(), [{ id: 'per_1', sessionID: 'ses_1' }]);
        assert.deepEqual(await client.pendingQuestions(), [{ id: 'frm_1', sessionID: 'ses_1' }]);
    });

    it('never dispatches a prompt with an unavailable or incompatible configured agent', async () => {
        for (const agents of [[], [{ id: 'missing', mode: 'subagent' }], [{ id: 'missing', hidden: true }]]) {
            fake.state.agents = agents;
            fake.calls.length = 0;
            const fresh = createOpencodeClientV2({ baseUrl: fake.url });
            await assert.rejects(fresh.prompt('ses_1', { agent: 'missing', parts: [] }), (error) => error.code === 'backend_agent_unavailable');
            assert.equal(callsTo('POST', '/api/session/ses_1/prompt').length, 0);
            assert.equal(callsTo('POST', '/api/session/ses_1/model').length, 0);
        }
        fake.state.agents = [{ id: 'plan' }];
    });

    it('initializes lazy agent plugins before declaring an agent unavailable', async () => {
        fake.state.lazyAgents = true;
        fake.state.modelsInitialized = false;
        fake.state.agents = [{ id: 'plan' }];
        fake.calls.length = 0;
        try {
            const fresh = createOpencodeClientV2({ baseUrl: fake.url });
            await fresh.prompt('ses_1', { agent: 'plan', parts: [{ type: 'text', text: 'hello' }] });
            assert.equal(callsTo('GET', '/api/agent').length, 2);
            assert.equal(callsTo('GET', '/api/model').length, 1);
            assert.equal(callsTo('POST', '/api/session/ses_1/agent').length, 1);
        } finally { fake.state.lazyAgents = false; }
    });

    it('interrupts and deletes sessions', async () => {
        fake.calls.length = 0;
        await client.abortSession('ses_1');
        await client.deleteSession('ses_1');
        assert.equal(callsTo('POST', '/api/session/ses_1/interrupt').length, 1);
        assert.equal(callsTo('DELETE', '/api/session/ses_1').length, 1);
    });

    it('reads a turn back as OpenCode 1 messages', async () => {
        const all = await client.messages('ses_1');
        assert.deepEqual(all.map((message) => message.info.role), ['user', 'assistant']);
        assert.equal((await client.message('ses_1', 'msg_a1')).info.id, 'msg_a1');
    });

    it('follows the cursor across pages without resending the order', async () => {
        fake.state.fillers = 450;
        try {
            fake.calls.length = 0;
            const all = await client.messages('ses_1');
            assert.equal(all.length, 452);
            assert.equal(all.at(-1).info.id, 'msg_a1');
            const pages = fake.calls.filter((call) => call.method === 'GET' && call.path === '/api/session/ses_1/message');
            assert.equal(pages.length, 3);
            assert.match(pages[0].query, /order=asc/);
            assert.ok(pages.slice(1).every((call) => call.query.includes('cursor=') && !call.query.includes('order=')));
        } finally {
            fake.state.fillers = 0;
        }
    });
});

describe('OpenCode 2 conversion', () => {
    it('maps model errors by their type', () => {
        const name = (type, extra = {}) => errorFromV2({ type, message: 'm', ...extra }).name;
        assert.equal(name('provider.auth', { status: 403 }), 'ProviderAuthError');
        assert.equal(name('context.overflow'), 'ContextOverflowError');
        assert.equal(name('session.interrupted'), 'MessageAbortedError');
        assert.equal(name('provider.error', { status: 429 }), 'APIError');
        assert.equal(name('something.else'), 'UnknownError');
        assert.equal(errorFromV2(undefined), undefined);
    });

    it('skips models that are switched off and keeps the rest', () => {
        const { providers } = providersFromModels([
            { providerID: 'opencode', modelID: 'a', enabled: true },
            { providerID: 'opencode', modelID: 'b', enabled: false },
            { providerID: 'other', modelID: 'c' },
            { modelID: 'orphan' },
        ]);
        assert.deepEqual(providers.map((provider) => [provider.id, Object.keys(provider.models)]), [['opencode', ['a']], ['other', ['c']]]);
    });

    it('ignores messages that are neither the user nor the assistant', () => {
        assert.equal(messageFromV2({ type: 'idle', id: 'msg_i' }, 'ses_1'), null);
    });

    it('turns the live stream into OpenCode 1 events', () => {
        const data = { sessionID: 'ses_1', assistantMessageID: 'msg_a', ordinal: 0 };
        const out = [
            { type: 'session.created', data: { sessionID: 'ses_2', parentID: 'ses_1' } },
            { type: 'session.step.started', data },
            { type: 'session.text.delta', data: { ...data, delta: 'Hel' } },
            { type: 'session.text.delta', data: { ...data, delta: 'lo' } },
            { type: 'session.tool.input.started', data: { sessionID: 'ses_1', assistantMessageID: 'msg_a', id: 'call_1', name: 'shell' } },
            { type: 'session.retry.scheduled', data: { sessionID: 'ses_1', attempt: 2, error: { message: 'busy' } } },
            { type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_1' } },
            { type: 'form.created', data: { form: { id: 'frm_1', sessionID: 'ses_1' } } },
            { type: 'session.usage.updated', data },
        ].flatMap(adaptEvent);

        // Every delta announces its part first, so a missed start event cannot lose text.
        assert.deepEqual(out.map((event) => event.type), [
            'session.created', 'message.updated',
            'message.part.updated', 'message.part.delta', 'message.part.updated', 'message.part.delta',
            'message.part.updated', 'session.status', 'permission.asked', 'question.asked',
        ]);
        assert.deepEqual(out[0].properties.info, { id: 'ses_2', parentID: 'ses_1' });
        const deltas = out.filter((event) => event.type === 'message.part.delta').map((event) => event.properties);
        assert.deepEqual(deltas.map((delta) => delta.delta), ['Hel', 'lo']);
        assert.equal(deltas[0].partID, out[2].properties.part.id);
        assert.equal(out[2].properties.part.type, 'text');
        assert.deepEqual(out[6].properties.part, { id: 'call_1', type: 'tool', tool: 'shell', sessionID: 'ses_1', messageID: 'msg_a' });
        assert.deepEqual(out[7].properties.status, { type: 'retry', attempt: 2, message: 'busy', error: { name: 'UnknownError', data: { message: 'busy' } } });
        assert.deepEqual(out[8].properties, { id: 'per_1', sessionID: 'ses_1' });
        assert.deepEqual(out[9].properties, { id: 'frm_1', sessionID: 'ses_1' });
    });

    it('drops requests that name no session, since they cannot be answered', () => {
        assert.deepEqual(adaptEvent({ type: 'permission.asked', data: { id: 'per_1' } }), []);
        assert.deepEqual(adaptEvent({ type: 'form.created', data: { form: { id: 'frm_1' } } }), []);
        assert.deepEqual(adaptEvent({ type: 'session.text.delta', data: { delta: 5 } }), []);
    });
});
