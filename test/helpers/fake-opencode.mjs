import http from 'node:http';

/**
 * A fake `opencode serve` for integration tests. It implements the HTTP
 * endpoints the gateway's client uses and an SSE /event stream. Each prompt is
 * answered by a pluggable behavior that can stream events before replying.
 */

export const FAKE_VERSION = '9.9.9-test';

export const DEFAULT_PROVIDERS = Object.freeze({
    providers: [
        {
            id: 'opencode',
            models: {
                'big-pickle': {
                    id: 'big-pickle',
                    name: 'Big Pickle',
                    release_date: '2025-01-01',
                    capabilities: { input: { text: true, image: false }, reasoning: true },
                    variants: { high: {}, low: {} },
                    limit: { context: 200000, output: 32000 },
                },
                'vision-free': {
                    id: 'vision-free',
                    name: 'Vision Free',
                    capabilities: { input: { text: true, image: true } },
                },
                'old-model': { id: 'old-model', status: 'deprecated' },
            },
        },
        { id: 'other', models: { x1: { name: 'X1' } } },
    ],
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let counter = 0;
const nextId = (prefix) => `${prefix}_${(counter += 1).toString(36)}`;

function readJson(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            if (!raw) return resolve(undefined);
            try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
        });
        req.on('error', reject);
    });
}

function sendJson(res, status, body) {
    if (res.writableEnded || res.destroyed) return;
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(text);
}

/** The first text part of a prompt body. */
export function promptText(body) {
    return (body?.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('');
}

/**
 * Stream an assistant turn over /event, then return the final message.
 * @param {object} ctx behavior context
 * @param {{ text?: string, reasoning?: string, chunks?: string[], tokens?: object, finish?: string, error?: object, settleMs?: number }} turn
 */
export async function streamTurn(ctx, {
    text = '', reasoning = '', chunks, reasoningChunks, tokens = { input: 10, output: 5, reasoning: 0, cache: { read: 2 } },
    finish = 'stop', error, settleMs = 40, structured,
} = {}) {
    const { sessionId, emit } = ctx;
    const messageID = nextId('msg');
    emit({ type: 'message.updated', properties: { sessionID: sessionId, info: { id: messageID, role: 'assistant', sessionID: sessionId } } });
    const parts = [];
    if (reasoning) {
        const partID = nextId('prt');
        emit({ type: 'message.part.updated', properties: { part: { id: partID, type: 'reasoning', sessionID: sessionId, messageID } } });
        for (const delta of reasoningChunks || [reasoning]) {
            emit({ type: 'message.part.delta', properties: { sessionID: sessionId, messageID, partID, field: 'text', delta } });
        }
        parts.push({ id: partID, type: 'reasoning', text: reasoning });
    }
    if (text) {
        const partID = nextId('prt');
        emit({ type: 'message.part.updated', properties: { part: { id: partID, type: 'text', sessionID: sessionId, messageID } } });
        for (const delta of chunks || [text]) {
            emit({ type: 'message.part.delta', properties: { sessionID: sessionId, messageID, partID, field: 'text', delta } });
        }
        parts.push({ id: partID, type: 'text', text });
    }
    await delay(settleMs);
    const info = {
        id: messageID, role: 'assistant', sessionID: sessionId, tokens, finish,
        ...(error ? { error } : {}),
        ...(structured !== undefined ? { structured } : {}),
    };
    return { info, parts };
}

/** Default behavior: echo the prompt text back in two chunks. */
export const echoBehavior = (ctx) => {
    const text = `Echo: ${promptText(ctx.body)}`;
    const mid = Math.ceil(text.length / 2);
    return streamTurn(ctx, { text, chunks: [text.slice(0, mid), text.slice(mid)] });
};

/**
 * @param {{ providers?: object, pendingPermissions?: object[], pendingQuestions?: object[] }} [options]
 */
export async function startFakeOpencode({ providers = DEFAULT_PROVIDERS, pendingPermissions = [], pendingQuestions = [] } = {}) {
    const state = {
        sessions: new Map(),
        created: [],
        deleted: [],
        aborted: [],
        prompts: [],
        permissionReplies: [],
        questionRejects: [],
        healthy: true,
        providersCalls: 0,
        providersFail: false,
    };
    const eventClients = new Set();
    const abortWaiters = new Map();
    let behavior = echoBehavior;

    const emit = (event) => {
        const frame = `data: ${JSON.stringify(event)}\n\n`;
        for (const res of eventClients) res.write(frame);
    };

    async function handlePrompt(req, res, sessionId) {
        const body = await readJson(req);
        state.prompts.push({ sessionId, body });
        const session = state.sessions.get(sessionId);
        const aborted = new Promise((resolve) => abortWaiters.set(sessionId, resolve));
        const closed = new Promise((resolve) => res.on('close', resolve));
        const ctx = {
            sessionId, body, emit, state,
            /** Resolves when the gateway aborts the session or drops the request. */
            untilAborted: Promise.race([aborted, closed]),
        };
        const result = await behavior(ctx);
        abortWaiters.delete(sessionId);
        if (!result) return;
        const user = { info: { id: nextId('msg'), role: 'user', sessionID: sessionId, ...(body?.format ? { format: body.format } : {}) }, parts: [] };
        if (session) session.messages.push(user, ...(result.extraMessages || []), { info: result.info, parts: result.parts });
        sendJson(res, 200, { info: result.info, parts: result.parts });
    }

    async function route(req, res) {
        const url = new URL(req.url, 'http://fake');
        const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const key = `${req.method} /${segments[0] || ''}`;

        if (key === 'GET /global' && segments[1] === 'health') {
            return state.healthy ? sendJson(res, 200, { healthy: true, version: FAKE_VERSION }) : sendJson(res, 503, { healthy: false });
        }
        if (key === 'GET /config' && segments[1] === 'providers') {
            state.providersCalls += 1;
            return state.providersFail ? sendJson(res, 500, { error: 'boom' }) : sendJson(res, 200, providers);
        }
        if (key === 'GET /event') {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            res.flushHeaders();
            res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
            eventClients.add(res);
            res.on('close', () => eventClients.delete(res));
            return undefined;
        }
        if (key === 'GET /permission') return sendJson(res, 200, pendingPermissions);
        if (key === 'GET /question') return sendJson(res, 200, pendingQuestions);
        if (key === 'POST /permission' && segments[2] === 'reply') {
            state.permissionReplies.push({ id: segments[1], body: await readJson(req) });
            return sendJson(res, 200, true);
        }
        if (key === 'POST /question' && segments[2] === 'reject') {
            await readJson(req);
            state.questionRejects.push(segments[1]);
            return sendJson(res, 200, true);
        }
        if (key === 'POST /session' && segments.length === 1) {
            await readJson(req);
            const id = nextId('ses');
            state.sessions.set(id, { id, messages: [] });
            state.created.push(id);
            return sendJson(res, 200, { id, title: 'openai-gateway' });
        }
        if (segments[0] === 'session' && segments[1]) {
            const sessionId = segments[1];
            if (req.method === 'DELETE' && segments.length === 2) {
                state.deleted.push(sessionId);
                state.sessions.delete(sessionId);
                return sendJson(res, 200, true);
            }
            if (req.method === 'POST' && segments[2] === 'abort') {
                state.aborted.push(sessionId);
                abortWaiters.get(sessionId)?.();
                return sendJson(res, 200, true);
            }
            if (req.method === 'POST' && segments[2] === 'message') return handlePrompt(req, res, sessionId);
            if (req.method === 'GET' && segments[2] === 'message' && segments[3]) {
                const found = (state.sessions.get(sessionId)?.messages || []).find((m) => m?.info?.id === segments[3]);
                return found ? sendJson(res, 200, found) : sendJson(res, 404, { error: 'not found' });
            }
            if (req.method === 'GET' && segments[2] === 'message') {
                // Like OpenCode 1.18, the listing fails to encode a stored output format.
                const messages = state.sessions.get(sessionId)?.messages || [];
                if (messages.some((m) => m.info?.format)) return sendJson(res, 400, { name: 'BadRequest', data: { message: 'Expected OutputFormatJsonSchema' } });
                return sendJson(res, 200, messages);
            }
        }
        return sendJson(res, 404, { error: 'not found' });
    }

    const server = http.createServer((req, res) => {
        route(req, res).catch((error) => sendJson(res, 500, { error: error.message }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    return {
        url: `http://127.0.0.1:${port}`,
        state,
        emit,
        setBehavior(fn) { behavior = fn || echoBehavior; },
        eventClientCount: () => eventClients.size,
        async close() {
            for (const res of eventClients) res.end();
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

/** Poll `check` until it returns truthy or the timeout elapses. */
export async function waitFor(check, { timeoutMs = 3000, intervalMs = 10 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('waitFor timed out');
        await delay(intervalMs);
    }
}
