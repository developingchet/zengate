import http from 'node:http';

export const FAKE_V2_VERSION = '2.0.0-test';

const MODELS = [
    {
        id: 'big-pickle',
        modelID: 'big-pickle',
        providerID: 'opencode',
        name: 'Big Pickle',
        compatibility: { reasoningField: 'reasoning_content' },
        capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
        variants: [{ id: 'high' }, { id: 'low' }],
        time: { released: Date.parse('2025-10-17T00:00:00Z') },
        status: 'active',
        enabled: true,
        limit: { context: 200000, output: 32000 },
    },
    { id: 'off', modelID: 'off', providerID: 'opencode', name: 'Off', capabilities: { tools: true, input: ['text'], output: ['text'] }, enabled: false },
];

/**
 * A fake OpenCode 2 `opencode serve`: the routes the v2 client uses, with the
 * web-app fallback that OpenCode 2 serves for the OpenCode 1 routes. Requests
 * are recorded in `calls`; `state` steers the turn it produces.
 */
export async function startFakeOpencodeV2() {
    const calls = [];
    const state = {
        agents: [],
        waitStatus: 204,
        // Messages in newest-first order, as the real server lists them when asked for desc;
        // asc requests get the reverse.
        assistant: { id: 'msg_a1', type: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'hello' }], finish: 'stop', tokens: { input: 5, output: 2, reasoning: 1, cache: { read: 3, write: 0 } } },
        pollsBeforeIdle: 0,
    };
    let sessions = 0;
    let polls = 0;

    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : undefined;
        const url = new URL(req.url, 'http://x');
        calls.push({ method: req.method, path: url.pathname, query: url.search, body });
        const json = (status, payload) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
        };
        const empty = (status = 204) => { res.writeHead(status); res.end(); };
        const route = `${req.method} ${url.pathname.replace(/\b(ses|msg|per|frm)_\w+/g, ':id').replace(/(?<=entries\/)[\w.-]+/, ':key')}`;

        switch (route) {
            case 'GET /api/info': return json(200, { version: FAKE_V2_VERSION, pid: 1, urls: [], paths: { tmp: '' } });
            case 'GET /api/model': return json(200, { data: MODELS });
            case 'GET /api/agent': return state.failAgents ? json(500, { _tag: 'UnknownError' }) : json(200, { data: state.agents });
            case 'POST /api/session': sessions += 1; return json(200, { data: { id: `ses_${sessions}` } });
            case 'DELETE /api/session/:id': return empty();
            case 'POST /api/session/:id/model':
            case 'POST /api/session/:id/agent':
            case 'PUT /api/experimental/session/:id/instructions/entries/:key':
            case 'POST /api/session/:id/interrupt': return empty();
            case 'POST /api/session/:id/prompt': return json(200, state.promptReply ?? { data: { id: 'msg_u1', type: 'user' } });
            case 'POST /api/experimental/session/:id/wait': return state.waitStatus === 204 ? empty() : json(state.waitStatus, { _tag: 'NotFound' });
            case 'GET /api/session/:id/message': {
                polls += 1;
                const finished = polls > state.pollsBeforeIdle;
                const ending = state.noAnswer ? [{ id: 'msg_i1', type: 'idle', outcome: state.noAnswer }] : [state.assistant, { id: 'msg_i1', type: 'idle', outcome: 'succeeded' }];
                const items = [
                    { id: 'msg_u1', type: 'user', text: 'prompt text' },
                    ...(finished ? ending : []),
                ];
                return json(200, { data: items, cursor: {} });
            }
            case 'GET /api/session/:id/message/:id': return json(200, { data: state.assistant });
            case 'GET /api/permission/request': return json(200, { data: [{ id: 'per_1', sessionID: 'ses_1' }] });
            case 'GET /api/form': return json(200, { data: [{ id: 'frm_1', sessionID: 'ses_1' }] });
            case 'POST /api/session/:id/permission/:id/reply':
            case 'DELETE /api/session/:id/form/:id': return empty();
            default:
                // OpenCode 2 answers every other path with its web app.
                res.writeHead(200, { 'content-type': 'text/html' });
                return res.end('<!doctype html><title>OpenCode</title>');
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}`,
        calls,
        state,
        close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
    };
}
