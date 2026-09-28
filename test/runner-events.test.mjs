import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BackendError } from '../src/opencode/client.js';
import { TOOL_REJECTION_MESSAGE, createEventHub } from '../src/opencode/events.js';
import { createRunner } from '../src/opencode/runner.js';
import { ApiError } from '../src/server/errors.js';
import { createLogger, silentLogger } from '../src/logger.js';
import { waitFor } from './helpers/fake-opencode.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeHub({ connected = true } = {}) {
    const listeners = new Map();
    return {
        listeners,
        released: [],
        subscribe(id, fn) {
            listeners.set(id, fn);
            return () => listeners.delete(id);
        },
        release(id) { this.released.push(id); },
        isConnected: () => connected,
        emit(id, event) { listeners.get(id)?.(event); },
    };
}

const abortable = (signal) => new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
});

const assistant = (id, text, extra = {}) => ({
    info: { id, role: 'assistant', tokens: { input: 3, output: 2, reasoning: 1, cache: { read: 1 } }, finish: 'stop', ...extra },
    parts: [{ type: 'reasoning', text: `think-${id}` }, { type: 'text', text }, { type: 'tool', tool: 'read' }],
});

function setup({ prompt, messages = async () => [], message, createSession, deleteSession, hubOptions, logger = silentLogger } = {}) {
    const hub = fakeHub(hubOptions);
    const log = { aborted: [], deleted: [], bodies: [] };
    const client = {
        createSession: createSession || (async () => ({ id: 'ses_1' })),
        async prompt(sessionId, body, { signal }) {
            log.bodies.push(body);
            return prompt({ sessionId, body, signal, emit: (event) => hub.emit(sessionId, event) });
        },
        messages,
        message: message || (async () => { throw new Error('unexpected single-message read'); }),
        abortSession: async (id) => { log.aborted.push(id); },
        deleteSession: deleteSession || (async (id) => { log.deleted.push(id); }),
    };
    const runner = createRunner({ getClient: () => client, hub, logger, agent: 'plan' });
    return { runner, hub, log };
}

const REQUEST = { model: { providerID: 'opencode', modelID: 'big-pickle' }, system: 'sys', parts: [{ type: 'text', text: 'hi' }], variant: 'high', format: { type: 'json_schema', schema: {} } };

async function runCollect(runner, request = REQUEST, signal = new AbortController().signal) {
    const deltas = [];
    const result = await runner.run(request, { signal, onDelta: (kind, text) => deltas.push([kind, text]) });
    return { result, deltas };
}

describe('runner', () => {
    it('streams assistant deltas, reconciles the final text and cleans up', async () => {
        const { runner, hub, log } = setup({
            async prompt({ emit, sessionId }) {
                emit({ type: 'message.updated', properties: { info: { id: 'u1', role: 'user' } } });
                emit({ type: 'message.part.delta', properties: { messageID: 'u1', partID: 'up', field: 'text', delta: 'user echo' } });
                emit({ type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant' } } });
                emit({ type: 'message.part.delta', properties: { messageID: 'm1', partID: 'p1', field: 'text', delta: 'Hel' } });
                emit({ type: 'message.part.updated', properties: { part: { id: 'p1', type: 'text' } } });
                emit({ type: 'message.part.delta', properties: { messageID: 'm1', partID: 'p1', field: 'text', delta: 'lo' } });
                emit({ type: 'message.part.updated', properties: { part: { id: 'r1', type: 'reasoning' } } });
                emit({ type: 'message.part.delta', properties: { messageID: 'm1', partID: 'r1', field: 'text', delta: 'think-m1' } });
                emit({ type: 'message.part.updated', properties: { part: { id: 't1', type: 'tool', tool: 'read' } } });
                emit({ type: 'message.part.delta', properties: { messageID: 'm1', partID: 't1', field: 'text', delta: 'tool noise' } });
                emit({ type: 'message.part.delta', properties: { messageID: 'm1', partID: 'p1', field: 'other', delta: 'x' } });
                emit({ type: 'session.status', properties: { status: { type: 'busy' } } });
                assert.equal(sessionId, 'ses_1');
                return assistant('m1', 'Hello world');
            },
        });
        const { result, deltas } = await runCollect(runner);
        assert.deepEqual(deltas, [['text', 'Hel'], ['text', 'lo'], ['reasoning', 'think-m1'], ['text', ' world']]);
        assert.equal(result.text, 'Hello world');
        assert.equal(result.reasoning, 'think-m1');
        assert.deepEqual(result.usage, { input: 3, output: 2, reasoning: 1, cacheRead: 1 });
        assert.equal(result.finish, 'stop');
        assert.deepEqual(log.bodies[0], { model: REQUEST.model, agent: 'plan', parts: REQUEST.parts, system: 'sys', variant: 'high', format: REQUEST.format });
        await tick();
        assert.deepEqual(log.deleted, ['ses_1']);
        assert.deepEqual(hub.released, ['ses_1']);
        assert.equal(hub.listeners.size, 0);
        assert.deepEqual(log.aborted, []);
    });

    it('omits optional prompt fields', async () => {
        const { runner, log } = setup({ prompt: async () => assistant('m', 'x') });
        await runCollect(runner, { model: REQUEST.model, parts: REQUEST.parts });
        assert.deepEqual(Object.keys(log.bodies[0]), ['model', 'agent', 'parts']);
    });

    it('re-reads the earlier assistant messages one by one when the turn spans several', async () => {
        const reads = [];
        const { runner } = setup({
            async prompt({ emit }) {
                emit({ type: 'message.updated', properties: { info: { id: 'a1', role: 'assistant' } } });
                emit({ type: 'message.part.updated', properties: { part: { id: 'p1', type: 'text' } } });
                emit({ type: 'message.part.delta', properties: { messageID: 'a1', partID: 'p1', field: 'text', delta: 'First' } });
                emit({ type: 'message.updated', properties: { info: { id: 'a2', role: 'assistant' } } });
                emit({ type: 'message.part.updated', properties: { part: { id: 'p2', type: 'text' } } });
                emit({ type: 'message.part.delta', properties: { messageID: 'a2', partID: 'p2', field: 'text', delta: 'Second' } });
                return assistant('a2', 'Second', { finish: 'length' });
            },
            messages: async () => { throw new BackendError('listing must not be used', { status: 400 }); },
            message: async (sessionId, messageId) => {
                reads.push([sessionId, messageId]);
                return assistant(messageId, 'First');
            },
        });
        const { result, deltas } = await runCollect(runner);
        assert.deepEqual(reads, [['ses_1', 'a1']]);
        assert.deepEqual(deltas.filter(([kind]) => kind === 'text'), [['text', 'First'], ['text', '\n\nSecond']]);
        assert.equal(result.text, 'First\n\nSecond');
        assert.equal(result.reasoning, 'think-a1\n\nthink-a2');
        assert.deepEqual(result.usage, { input: 6, output: 4, reasoning: 2, cacheRead: 2 });
        assert.equal(result.finish, 'length');
    });

    it('re-reads messages when the event stream is down', async () => {
        const { runner } = setup({ hubOptions: { connected: false }, prompt: async () => assistant('m', 'stale'), messages: async () => [assistant('m', 'fresh')] });
        const { result, deltas } = await runCollect(runner);
        assert.equal(result.text, 'fresh');
        assert.deepEqual(deltas.sort(), [['reasoning', 'think-m'], ['text', 'fresh']]);
    });

    it('answers from the final message when an earlier one cannot be read', async () => {
        const warnings = [];
        const logger = createLogger({ level: 'warn', sink: { out: () => {}, err: (line) => warnings.push(line) } });
        const { runner } = setup({
            logger,
            async prompt({ emit }) {
                emit({ type: 'message.updated', properties: { info: { id: 'a1', role: 'assistant' } } });
                emit({ type: 'message.updated', properties: { info: { id: 'a2', role: 'assistant' } } });
                return assistant('a2', 'Final');
            },
            message: async () => { throw new BackendError('OpenCode GET failed with HTTP 400', { status: 400 }); },
        });
        const { result } = await runCollect(runner);
        assert.equal(result.text, 'Final');
        assert.deepEqual(result.usage, { input: 3, output: 2, reasoning: 1, cacheRead: 1 });
        assert.ok(warnings.some((line) => /Could not re-read the OpenCode turn/.test(line)));
    });

    it('answers from the final message when the listing fails with the event stream down', async () => {
        const { runner } = setup({
            hubOptions: { connected: false },
            prompt: async () => assistant('m', 'final'),
            messages: async () => { throw new BackendError('OpenCode GET failed with HTTP 400', { status: 400 }); },
        });
        assert.equal((await runCollect(runner)).result.text, 'final');
    });

    it('does not fall back when the caller aborts during the re-read', async () => {
        const controller = new AbortController();
        const { runner } = setup({
            async prompt({ emit }) {
                emit({ type: 'message.updated', properties: { info: { id: 'a1', role: 'assistant' } } });
                emit({ type: 'message.updated', properties: { info: { id: 'a2', role: 'assistant' } } });
                return assistant('a2', 'Final');
            },
            message: async (sessionId, messageId, { signal }) => {
                controller.abort(new Error('client went away'));
                return abortable(signal);
            },
        });
        await assert.rejects(runCollect(runner, REQUEST, controller.signal), /client went away/);
    });

    it('maps finish reasons and model errors', async () => {
        const run = async (info) => {
            const { runner } = setup({ prompt: async () => ({ info: { role: 'assistant', ...info }, parts: [] }) });
            return (await runCollect(runner)).result;
        };
        assert.equal((await run({ finish: 'content-filter' })).finish, 'content_filter');
        assert.equal((await run({ finish: 'length' })).finish, 'length');
        assert.equal((await run({ error: { name: 'MessageOutputLengthError' } })).finish, 'length');
        assert.deepEqual((await run({ structured: { a: 1 } })).structured, { a: 1 });
        assert.deepEqual((await run({})).usage, { input: 0, output: 0, reasoning: 0, cacheRead: 0 });
        await assert.rejects(run({ error: { name: 'APIError', data: { statusCode: 429 } } }), { status: 429, code: 'upstream_rate_limited' });
    });

    it('maps session creation failures', async () => {
        const failing = setup({ createSession: async () => { throw new BackendError('down', { status: 500 }); } });
        await assert.rejects(runCollect(failing.runner), { status: 503, code: 'backend_unavailable' });
        const noId = setup({ createSession: async () => ({}) });
        await assert.rejects(runCollect(noId.runner), { status: 503 });
    });

    it('maps prompt failures', async () => {
        const { runner, log } = setup({ prompt: async () => { throw new BackendError('bad', { status: 400, body: { error: 'bad model' } }); } });
        await assert.rejects(runCollect(runner), { status: 400, code: 'backend_rejected' });
        await tick();
        assert.deepEqual(log.deleted, ['ses_1']);
    });

    it('aborts the session when the caller aborts', async () => {
        const controller = new AbortController();
        const reason = new ApiError(504, 'timeout', { code: 'timeout' });
        const { runner, log } = setup({
            prompt: ({ signal }) => {
                setImmediate(() => controller.abort(reason));
                return abortable(signal);
            },
        });
        await assert.rejects(runCollect(runner, REQUEST, controller.signal), (error) => error === reason);
        assert.deepEqual(log.aborted, ['ses_1']);
    });

    it('handles a signal that is already aborted', async () => {
        const reason = new ApiError(499, 'gone');
        const { runner, log } = setup({ prompt: ({ signal }) => (signal.aborted ? Promise.reject(new Error('x')) : abortable(signal)) });
        await assert.rejects(runCollect(runner, REQUEST, AbortSignal.abort(reason)), (error) => error === reason);
        await tick();
        assert.deepEqual(log.deleted, ['ses_1'], 'the never-started session is still deleted');
    });

    it('gives up when OpenCode keeps retrying a failing upstream', async () => {
        const { runner, log } = setup({
            prompt: ({ emit, signal }) => {
                emit({ type: 'session.status', properties: { status: { type: 'retry', attempt: 1, message: 'overloaded' } } });
                emit({ type: 'session.status', properties: { status: { type: 'retry', attempt: 3, message: 'overloaded' } } });
                emit({ type: 'session.status', properties: { status: { type: 'retry', attempt: 4 } } });
                return abortable(signal);
            },
        });
        await assert.rejects(runCollect(runner), (error) => error.status === 502 && error.code === 'upstream_error' && /overloaded/.test(error.message));
        assert.deepEqual(log.aborted, ['ses_1']);
    });

    it('stops on a native attempt to call a client function', async () => {
        const request = { ...REQUEST, clientTools: ['get_weather'] };
        const attempt = async (part) => {
            const { runner, log } = setup({
                prompt: ({ emit, signal }) => {
                    emit({ type: 'message.part.updated', properties: { part: { id: 'x', type: 'tool', ...part } } });
                    emit({ type: 'message.part.updated', properties: { part: { id: 'y', type: 'tool', tool: 'get_weather' } } });
                    return abortable(signal);
                },
            });
            const { result } = await runCollect(runner, request);
            assert.deepEqual(log.aborted, ['ses_1']);
            return result;
        };
        assert.equal((await attempt({ tool: 'get_weather' })).nativeToolAttempt, 'get_weather');
        assert.equal((await attempt({ tool: 'invalid', state: { input: { tool: 'bash' } } })).nativeToolAttempt, 'bash');
        assert.equal((await attempt({ tool: 'invalid' })).nativeToolAttempt, 'unnamed tool');
        const result = await attempt({ tool: 'get_weather' });
        assert.deepEqual(result.usage, { input: 0, output: 0, reasoning: 0, cacheRead: 0 });
        assert.equal(result.text, '');
    });

    it('lets ordinary OpenCode tool parts pass', async () => {
        const { runner, log } = setup({
            prompt: async ({ emit }) => {
                emit({ type: 'message.part.updated', properties: { part: { id: 'x', type: 'tool', tool: 'read' } } });
                return assistant('m', 'done');
            },
        });
        const { result } = await runCollect(runner, { ...REQUEST, clientTools: ['get_weather'] });
        assert.equal(result.text, 'done');
        assert.deepEqual(log.aborted, []);
    });

    it('retries session deletion once and then gives up quietly', async () => {
        let attempts = 0;
        const flaky = setup({ prompt: async () => assistant('m', 'x'), deleteSession: async () => { attempts += 1; if (attempts === 1) throw new Error('busy'); } });
        await runCollect(flaky.runner);
        await waitFor(() => flaky.hub.released.length === 1);
        assert.equal(attempts, 2);

        const lines = [];
        const hub = fakeHub();
        const client = {
            createSession: async () => ({ id: 's' }),
            prompt: async () => assistant('m', 'x'),
            deleteSession: async () => { throw new Error('gone'); },
            abortSession: async () => {},
        };
        const logger = createLogger({ level: 'debug', sink: { out: (line) => lines.push(line), err: () => {} } });
        const runner = createRunner({ getClient: () => client, hub, logger, agent: 'plan' });
        await runner.run(REQUEST, { signal: new AbortController().signal });
        await waitFor(() => hub.released.length === 1);
        assert.ok(lines.some((line) => /Could not delete OpenCode session/.test(line)));
    });
});

/** A controllable SSE body for the event hub. */
function controllableStream(signal) {
    let controller;
    const stream = new ReadableStream({ start(c) { controller = c; } });
    signal?.addEventListener('abort', () => { try { controller.error(new Error('aborted')); } catch { /* closed */ } });
    return {
        body: stream,
        send(event) { controller.enqueue(new TextEncoder().encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)); },
        end() { controller.close(); },
    };
}

function hubSetup({ ownsAllSessions = false, pendingPermissions = async () => [], pendingQuestions = async () => [], replyPermission, rejectQuestion, openEvents } = {}) {
    const streams = [];
    const log = { replies: [], questions: [], warnings: [] };
    const client = {
        async openEvents(signal) {
            if (openEvents) return openEvents(signal);
            const stream = controllableStream(signal);
            streams.push(stream);
            return stream;
        },
        replyPermission: replyPermission || (async (id, reply, message) => { log.replies.push({ id, reply, message }); }),
        rejectQuestion: rejectQuestion || (async (id) => { log.questions.push(id); }),
        pendingPermissions,
        pendingQuestions,
    };
    const logger = createLogger({ level: 'warn', sink: { out: () => {}, err: (line) => log.warnings.push(line) } });
    const hub = createEventHub({ getClient: () => client, logger, ownsAllSessions });
    return { hub, streams, log };
}

describe('event hub', () => {
    it('connects, fans out events per session and survives bad frames and listeners', async (t) => {
        const { hub, streams, log } = hubSetup();
        t.after(() => hub.stop());
        assert.equal(hub.isConnected(), false);
        hub.start();
        hub.start();
        assert.equal(await hub.waitConnected(2000), true);
        assert.equal(await hub.waitConnected(1), true);
        const seen = [];
        const unsubscribe = hub.subscribe('s1', (event) => seen.push(event.type));
        hub.subscribe('s1', () => { throw new Error('listener bug'); });
        const stream = streams[0];
        stream.send('not json');
        stream.send({ noType: true });
        stream.send({ type: 'message.updated', properties: { info: { sessionID: 's1' } } });
        stream.send({ type: 'message.part.updated', properties: { part: { sessionID: 's1' } } });
        stream.send({ type: 'message.part.delta', properties: { sessionID: 's1' } });
        stream.send({ type: 'message.part.delta', properties: { sessionID: 'other' } });
        stream.send({ type: 'global.event', properties: {} });
        await waitFor(() => seen.length === 3);
        assert.deepEqual(seen, ['message.updated', 'message.part.updated', 'message.part.delta']);
        assert.ok(log.warnings.some((line) => /Event listener failed/.test(line)));
        unsubscribe();
        hub.release('s1');
    });

    it('rejects permissions and questions for its own sessions only', async (t) => {
        const { hub, streams, log } = hubSetup({ ownsAllSessions: false });
        t.after(() => hub.stop());
        hub.start();
        await hub.waitConnected(2000);
        hub.subscribe('mine', () => {});
        streams[0].send({ type: 'permission.asked', properties: { id: 'per_foreign', sessionID: 'foreign' } });
        streams[0].send({ type: 'permission.asked', properties: { id: 'per_mine', sessionID: 'mine' } });
        streams[0].send({ type: 'question.asked', properties: { id: 'que_mine', sessionID: 'mine' } });
        streams[0].send({ type: 'question.asked', properties: { id: 'que_foreign', sessionID: 'foreign' } });
        await waitFor(() => log.replies.length === 1 && log.questions.length === 1);
        assert.deepEqual(log.replies, [{ id: 'per_mine', reply: 'reject', message: TOOL_REJECTION_MESSAGE }]);
        assert.deepEqual(log.questions, ['que_mine']);
        hub.release('mine');
        streams[0].send({ type: 'permission.asked', properties: { id: 'per_after', sessionID: 'mine' } });
        streams[0].send({ type: 'permission.asked', properties: { id: 'per_marker', sessionID: 'foreign' } });
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(log.replies.length, 1, 'released sessions are no longer ours');
    });

    it('adopts child sessions of owned sessions and drops them on release', async (t) => {
        const { hub, streams, log } = hubSetup({ ownsAllSessions: false });
        t.after(() => hub.stop());
        hub.start();
        await hub.waitConnected(2000);
        hub.subscribe('parent', () => {});
        const send = (event) => streams[0].send(event);
        send({ type: 'session.created', properties: { info: { id: 'child', parentID: 'parent' } } });
        send({ type: 'session.updated', properties: { info: { id: 'child', parentID: 'parent' } } });
        send({ type: 'session.created', properties: { info: { id: 'grandchild', parentID: 'child' } } });
        send({ type: 'session.created', properties: { info: { id: 'stranger', parentID: 'foreign' } } });
        send({ type: 'session.created', properties: { info: { id: 'orphan' } } });
        send({ type: 'session.created', properties: {} });
        send({ type: 'permission.asked', properties: { id: 'p_child', sessionID: 'child' } });
        send({ type: 'permission.asked', properties: { id: 'p_grandchild', sessionID: 'grandchild' } });
        send({ type: 'permission.asked', properties: { id: 'p_stranger', sessionID: 'stranger' } });
        send({ type: 'permission.asked', properties: { id: 'p_orphan', sessionID: 'orphan' } });
        await waitFor(() => log.replies.length === 2);
        assert.deepEqual(log.replies.map((r) => r.id).sort(), ['p_child', 'p_grandchild']);

        hub.release('parent');
        send({ type: 'permission.asked', properties: { id: 'p_child_after', sessionID: 'child' } });
        hub.subscribe('marker', () => {});
        send({ type: 'permission.asked', properties: { id: 'p_marker', sessionID: 'marker' } });
        await waitFor(() => log.replies.some((r) => r.id === 'p_marker'));
        assert.equal(log.replies.some((r) => r.id === 'p_child_after'), false, 'children are released with their parent');
    });

    it('rejects every session in managed mode and sweeps pending requests on connect', async (t) => {
        const { hub, streams, log } = hubSetup({
            ownsAllSessions: true,
            pendingPermissions: async () => [{ id: 'p_old', sessionID: 'any' }, { sessionID: 'no-id' }],
            pendingQuestions: async () => { throw new Error('not supported'); },
        });
        t.after(() => hub.stop());
        hub.start();
        await hub.waitConnected(2000);
        await waitFor(() => log.replies.length === 1);
        assert.equal(log.replies[0].id, 'p_old');
        streams[0].send({ type: 'permission.asked', properties: { id: 'p_new', sessionID: 'whatever' } });
        await waitFor(() => log.replies.length === 2);
    });

    it('logs when a rejection fails', async (t) => {
        const { hub, streams, log } = hubSetup({
            ownsAllSessions: true,
            replyPermission: async () => { throw new Error('backend down'); },
            rejectQuestion: async () => { throw new Error('backend down'); },
        });
        t.after(() => hub.stop());
        hub.start();
        await hub.waitConnected(2000);
        streams[0].send({ type: 'permission.asked', properties: { id: 'p', sessionID: 's' } });
        await waitFor(() => log.warnings.some((line) => /Failed to reject an OpenCode tool permission/.test(line)));
        streams[0].send({ type: 'question.asked', properties: { id: 'q', sessionID: 's' } });
        await waitFor(() => log.warnings.some((line) => /Failed to reject an OpenCode question/.test(line)));
    });

    it('treats a request that is already gone as answered', async (t) => {
        const gone = () => { throw new BackendError('OpenCode POST failed with HTTP 404', { status: 404 }); };
        const { hub, streams, log } = hubSetup({ ownsAllSessions: true, replyPermission: async () => gone(), rejectQuestion: async () => gone() });
        t.after(() => hub.stop());
        hub.start();
        await hub.waitConnected(2000);
        streams[0].send({ type: 'permission.asked', properties: { id: 'p', sessionID: 's' } });
        streams[0].send({ type: 'question.asked', properties: { id: 'q', sessionID: 's' } });
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.deepEqual(log.warnings, []);
    });

    it('reconnects after the stream ends', async (t) => {
        const { hub, streams, log } = hubSetup();
        t.after(() => hub.stop());
        hub.start();
        await hub.waitConnected(2000);
        streams[0].end();
        await waitFor(() => streams.length === 2 && hub.isConnected(), { timeoutMs: 3000 });
        assert.ok(log.warnings.some((line) => /event stream ended/.test(line)));
    });

    it('reports not connected when the stream cannot be opened', async (t) => {
        let attempts = 0;
        const { hub } = hubSetup({ openEvents: async () => { attempts += 1; throw new Error('refused'); } });
        t.after(() => hub.stop());
        hub.start();
        assert.equal(await hub.waitConnected(50), false);
        assert.equal(hub.isConnected(), false);
        assert.ok(attempts >= 1);
    });

    it('stop cancels the stream even when fetch ignores the abort signal', async () => {
        // Regression: undici can drop the abort link after GC, which hung shutdown.
        const streams = [];
        const { hub } = hubSetup({
            openEvents: async () => {
                const stream = controllableStream(undefined);
                streams.push(stream);
                return stream;
            },
        });
        hub.start();
        await hub.waitConnected(2000);
        const stopped = await Promise.race([
            hub.stop().then(() => true),
            new Promise((resolve) => setTimeout(() => resolve(false), 2000).unref()),
        ]);
        assert.equal(stopped, true);
        assert.equal(streams.length, 1);
        assert.equal(hub.isConnected(), false);
    });

    it('stop is safe before start', async () => {
        const { hub } = hubSetup();
        await hub.stop();
    });
});
