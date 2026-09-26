import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_REJECTION_MESSAGE } from '../src/opencode/events.js';
import { FAKE_VERSION, promptText, streamTurn, waitFor } from './helpers/fake-opencode.mjs';
import { KEY, OTHER_KEY, readSse, startStack } from './helpers/gateway.mjs';

const MODEL = 'big-pickle';
const WEATHER_TOOL = { type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } };
const CALL_BLOCK = 'Checking. <tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>';

/** Behavior: answer with a tool call block when client functions are offered. */
const toolBehavior = (ctx) => (String(ctx.body.system || '').includes('# Client functions')
    ? streamTurn(ctx, { text: CALL_BLOCK, chunks: ['Checking. <tool_', 'call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>'] })
    : streamTurn(ctx, { text: 'no tools offered' }));

describe('gateway over HTTP (fake OpenCode backend)', () => {
    let stack;
    before(async () => { stack = await startStack(); });
    after(async () => { await stack?.stop(); });
    afterEach(() => stack.fake.setBehavior(null));

    const chat = (body, init) => stack.json('/v1/chat/completions', { body: { model: MODEL, messages: [{ role: 'user', content: 'hello' }], ...body }, ...init });

    describe('health, auth and routing', () => {
        it('serves /health without a key, with security headers', async () => {
            const response = await stack.request('/health', { key: null });
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { status: 'ok' });
            assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
            assert.equal(response.headers.get('x-powered-by'), null);
        });

        it('reports readiness with the backend mode and version', async () => {
            const { status, body } = await stack.json('/ready', { key: null });
            assert.equal(status, 200);
            assert.deepEqual(body, { status: 'ready', backend: 'attached', opencode: FAKE_VERSION });
        });

        it('rejects requests without or with a wrong key', async () => {
            const missing = await stack.json('/v1/models', { key: null });
            assert.equal(missing.status, 401);
            assert.equal(missing.body.error.code, 'invalid_api_key');
            assert.equal(missing.headers.get('www-authenticate'), 'Bearer');
            const wrong = await stack.json('/v1/models', { key: 'wrong-key-0000000000000000' });
            assert.equal(wrong.status, 401);
            assert.match(wrong.body.error.message, /Incorrect API key/);
        });

        it('answers unknown routes with a 404 envelope', async () => {
            const { status, body } = await stack.json('/v1/nope');
            assert.equal(status, 404);
            assert.deepEqual(body, { error: { message: 'Unknown endpoint: GET /v1/nope', type: 'not_found_error', param: null, code: 'unknown_url' } });
        });

        it('answers invalid JSON with 400', async () => {
            const { status, body } = await stack.json('/v1/chat/completions', { body: '{"model": ', headers: {} });
            assert.equal(status, 400);
            assert.equal(body.error.type, 'invalid_request_error');
            assert.match(body.error.message, /not valid JSON/);
        });

        it('echoes a sane x-request-id and generates one otherwise', async () => {
            const echoed = await stack.request('/v1/models', { headers: { 'x-request-id': 'trace-123' } });
            assert.equal(echoed.headers.get('x-request-id'), 'trace-123');
            const generated = await stack.request('/v1/models', { headers: { 'x-request-id': 'bad id!' } });
            assert.match(generated.headers.get('x-request-id'), /^req_[0-9a-f]{24}$/);
        });

        it('exposes metrics behind auth', async () => {
            assert.equal((await stack.request('/metrics', { key: null })).status, 401);
            const { status, body } = await stack.json('/metrics');
            assert.equal(status, 200);
            assert.equal(body.backend_ready, true);
            assert.equal(body.events_connected, true);
            assert.deepEqual(body.slots, { active: 0, queued: 0, maxConcurrent: 8, maxQueue: 32 });
            assert.ok(body.requests >= 1);
        });
    });

    describe('models', () => {
        it('lists models (deprecated ones hidden, other providers prefixed)', async () => {
            const { status, body } = await stack.json('/v1/models');
            assert.equal(status, 200);
            assert.equal(body.object, 'list');
            assert.deepEqual(body.data.map((m) => m.id), ['big-pickle', 'other/x1', 'vision-free']);
            assert.deepEqual(body.data[0], { id: 'big-pickle', object: 'model', created: Math.floor(Date.parse('2025-01-01') / 1000), owned_by: 'opencode' });
            const root = await stack.json('/models');
            assert.deepEqual(root.body, body, 'routes are also served without /v1');
        });

        it('retrieves models by id, including ids with a slash', async () => {
            assert.equal((await stack.json('/v1/models/big-pickle')).body.id, 'big-pickle');
            assert.equal((await stack.json('/v1/models/opencode/big-pickle')).body.id, 'big-pickle');
            assert.equal((await stack.json('/v1/models/other/x1')).body.owned_by, 'other');
            const missing = await stack.json('/v1/models/nope');
            assert.equal(missing.status, 404);
            assert.equal(missing.body.error.code, 'model_not_found');
        });
    });

    describe('chat completions', () => {
        it('returns a non-streaming completion and forwards the prompt', async () => {
            const before = stack.fake.state.prompts.length;
            const { status, body, headers } = await chat({ temperature: 0.3, reasoning_effort: 'high', messages: [{ role: 'system', content: 'Be nice' }, { role: 'user', content: 'hello' }] });
            assert.equal(status, 200);
            assert.equal(headers.get('x-gateway-ignored-params'), 'temperature');
            assert.match(body.id, /^chatcmpl-/);
            assert.equal(body.object, 'chat.completion');
            assert.equal(body.model, MODEL);
            assert.equal(body.choices.length, 1);
            assert.deepEqual(body.choices[0].message, { role: 'assistant', content: 'Echo: hello', refusal: null, annotations: [] });
            assert.equal(body.choices[0].finish_reason, 'stop');
            assert.deepEqual(body.usage, {
                prompt_tokens: 12, completion_tokens: 5, total_tokens: 17,
                prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 0 },
            });
            const sent = stack.fake.state.prompts[before].body;
            assert.deepEqual(sent.model, { providerID: 'opencode', modelID: 'big-pickle' });
            assert.equal(sent.agent, 'plan');
            assert.equal(sent.system, 'Be nice');
            assert.equal(sent.variant, 'high');
            assert.deepEqual(sent.parts, [{ type: 'text', text: 'hello' }]);
        });

        it('deletes the OpenCode session after every run', async () => {
            await chat({});
            await waitFor(() => stack.fake.state.created.every((id) => stack.fake.state.deleted.includes(id)));
            assert.equal(stack.fake.state.sessions.size, 0);
        });

        it('streams role, content deltas, finish, usage and [DONE]', async () => {
            const response = await stack.request('/v1/chat/completions', { body: { model: MODEL, messages: [{ role: 'user', content: 'stream me' }], stream: true, stream_options: { include_usage: true } } });
            assert.equal(response.status, 200);
            assert.match(response.headers.get('content-type'), /^text\/event-stream/);
            const frames = await readSse(response);
            assert.equal(frames.at(-1).data, '[DONE]');
            const chunks = frames.slice(0, -1).map((f) => f.data);
            assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk' && c.id === chunks[0].id));
            assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant', content: '', refusal: null });
            const contentChunks = chunks.filter((c) => c.choices[0]?.delta?.content);
            assert.ok(contentChunks.length >= 2, 'text arrives as several deltas');
            assert.equal(contentChunks.map((c) => c.choices[0].delta.content).join(''), 'Echo: stream me');
            const finish = chunks.find((c) => c.choices[0]?.finish_reason);
            assert.equal(finish.choices[0].finish_reason, 'stop');
            assert.deepEqual(finish.choices[0].delta, {});
            assert.ok(chunks.slice(0, -1).every((c) => c.usage === null));
            const usage = chunks.at(-1);
            assert.deepEqual(usage.choices, []);
            assert.equal(usage.usage.total_tokens, 17);
        });

        it('streams without a usage chunk by default', async () => {
            const frames = await readSse(await stack.request('/v1/chat/completions', { body: { model: MODEL, messages: [{ role: 'user', content: 'x' }], stream: true } }));
            const chunks = frames.slice(0, -1).map((f) => f.data);
            assert.ok(chunks.every((c) => c.choices.length === 1 && !('usage' in c)));
        });

        it('streams reasoning as reasoning_content and includes it in JSON responses', async () => {
            stack.fake.setBehavior((ctx) => streamTurn(ctx, { reasoning: 'thinking', text: 'answer', tokens: { input: 1, output: 1, reasoning: 4, cache: { read: 0 } } }));
            const { body } = await chat({});
            assert.equal(body.choices[0].message.reasoning_content, 'thinking');
            assert.equal(body.usage.completion_tokens_details.reasoning_tokens, 4);
            const frames = await readSse(await stack.request('/v1/chat/completions', { body: { model: MODEL, messages: [{ role: 'user', content: 'x' }], stream: true } }));
            const reasoning = frames.slice(0, -1).map((f) => f.data.choices[0]?.delta?.reasoning_content).filter(Boolean).join('');
            assert.equal(reasoning, 'thinking');
        });

        it('returns tool_calls when the model calls a client function', async () => {
            stack.fake.setBehavior(toolBehavior);
            const { status, body } = await chat({ tools: [WEATHER_TOOL] });
            assert.equal(status, 200);
            const [choice] = body.choices;
            assert.equal(choice.finish_reason, 'tool_calls');
            assert.equal(choice.message.content, 'Checking. ');
            assert.equal(choice.message.tool_calls.length, 1);
            const [call] = choice.message.tool_calls;
            assert.match(call.id, /^call_/);
            assert.equal(call.type, 'function');
            assert.deepEqual({ name: call.function.name, args: JSON.parse(call.function.arguments) }, { name: 'get_weather', args: { city: 'Paris' } });
            const sent = stack.fake.state.prompts.at(-1).body;
            assert.match(sent.system, /- get_weather: Weather/);
        });

        it('streams tool_calls as an indexed delta', async () => {
            stack.fake.setBehavior(toolBehavior);
            const frames = await readSse(await stack.request('/v1/chat/completions', { body: { model: MODEL, messages: [{ role: 'user', content: 'x' }], tools: [WEATHER_TOOL], stream: true } }));
            const chunks = frames.slice(0, -1).map((f) => f.data);
            const text = chunks.map((c) => c.choices[0]?.delta?.content || '').join('');
            assert.equal(text, 'Checking. ', 'the call block never leaks into content');
            const callChunk = chunks.find((c) => c.choices[0]?.delta?.tool_calls);
            assert.equal(callChunk.choices[0].delta.tool_calls[0].index, 0);
            assert.equal(callChunk.choices[0].delta.tool_calls[0].function.name, 'get_weather');
            assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
        });

        it('returns function_call for legacy functions requests', async () => {
            stack.fake.setBehavior(toolBehavior);
            const { body } = await chat({ functions: [WEATHER_TOOL.function] });
            const [choice] = body.choices;
            assert.equal(choice.finish_reason, 'function_call');
            assert.equal(choice.message.tool_calls, undefined);
            assert.equal(choice.message.function_call.name, 'get_weather');
            assert.deepEqual(JSON.parse(choice.message.function_call.arguments), { city: 'Paris' });
            assert.match(stack.fake.state.prompts.at(-1).body.system, /at most one function/);

            const frames = await readSse(await stack.request('/v1/chat/completions', { body: { model: MODEL, messages: [{ role: 'user', content: 'x' }], functions: [WEATHER_TOOL.function], stream: true } }));
            const chunks = frames.slice(0, -1).map((f) => f.data);
            const fnChunk = chunks.find((c) => c.choices[0]?.delta?.function_call);
            assert.equal(fnChunk.choices[0].delta.function_call.name, 'get_weather');
            assert.equal(chunks.some((c) => c.choices[0]?.delta?.tool_calls), false);
            assert.equal(chunks.at(-1).choices[0].finish_reason, 'function_call');
        });

        it('sends tool results back as a transcript', async () => {
            await chat({
                tools: [WEATHER_TOOL],
                messages: [
                    { role: 'user', content: 'weather?' },
                    { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
                    { role: 'tool', tool_call_id: 'call_a', content: '22C' },
                ],
            });
            const text = promptText(stack.fake.state.prompts.at(-1).body);
            assert.match(text, /<tool_result name="get_weather" call_id="call_a">\n22C\n<\/tool_result>/);
        });

        it('runs n choices as separate generations', async () => {
            const before = stack.fake.state.prompts.length;
            const { body } = await chat({ n: 2 });
            assert.deepEqual(body.choices.map((c) => c.index), [0, 1]);
            assert.equal(stack.fake.state.prompts.length - before, 2);
            assert.equal(body.usage.prompt_tokens, 24);
        });

        it('uses native structured output for json_schema without tools', async () => {
            stack.fake.setBehavior((ctx) => streamTurn(ctx, { text: 'Here you go', structured: { answer: 42 } }));
            const schema = { type: 'object', properties: { answer: { type: 'number' } } };
            const { body } = await chat({ response_format: { type: 'json_schema', json_schema: { name: 'a', schema } } });
            assert.equal(body.choices[0].message.content, '{"answer":42}');
            assert.deepEqual(stack.fake.state.prompts.at(-1).body.format, { type: 'json_schema', schema });
        });

        it('joins several assistant messages when OpenCode continues after a rejected tool', async () => {
            stack.fake.setBehavior(async (ctx) => {
                const first = await streamTurn(ctx, { text: 'First', settleMs: 0 });
                const second = await streamTurn(ctx, { text: 'Second' });
                return { ...second, extraMessages: [first] };
            });
            const { body } = await chat({});
            assert.equal(body.choices[0].message.content, 'First\n\nSecond');
            assert.equal(body.usage.prompt_tokens, 24);
        });

        it('maps upstream failures to OpenAI errors', async () => {
            stack.fake.setBehavior((ctx) => streamTurn(ctx, { error: { name: 'APIError', data: { statusCode: 429, message: 'slow down', responseHeaders: { 'retry-after': '7' } } } }));
            const { status, body, headers } = await chat({});
            assert.equal(status, 429);
            assert.equal(body.error.code, 'upstream_rate_limited');
            assert.equal(headers.get('retry-after'), '7');

            const frames = await readSse(await stack.request('/v1/chat/completions', { body: { model: MODEL, messages: [{ role: 'user', content: 'x' }], stream: true } }));
            assert.equal(frames.at(-1).data, '[DONE]');
            assert.equal(frames.at(-2).data.error.code, 'upstream_rate_limited');
        });

        it('reports a truncated answer as finish_reason length', async () => {
            stack.fake.setBehavior((ctx) => streamTurn(ctx, { text: 'cut', finish: 'length' }));
            assert.equal((await chat({})).body.choices[0].finish_reason, 'length');
        });

        it('validates requests before touching the backend', async () => {
            const before = stack.fake.state.created.length;
            const missing = await chat({ model: 'nope' });
            assert.equal(missing.status, 404);
            assert.equal(missing.body.error.code, 'model_not_found');
            assert.equal((await chat({ logprobs: true })).body.error.code, 'unsupported_parameter');
            const image = { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('p').toString('base64')}` } }] };
            const modality = await chat({ messages: [image] });
            assert.equal(modality.status, 400);
            assert.equal(modality.body.error.code, 'unsupported_modality');
            const ssrf = await chat({ model: 'vision-free', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://127.0.0.1/x.png' } }] }] });
            assert.equal(ssrf.status, 400);
            assert.equal(ssrf.body.error.code, 'invalid_attachment_url');
            assert.equal(stack.fake.state.created.length, before, 'no OpenCode session was created');
        });

        it('accepts images for vision models', async () => {
            const png = `data:image/png;base64,${Buffer.from('p').toString('base64')}`;
            const { status } = await chat({ model: 'vision-free', messages: [{ role: 'user', content: [{ type: 'text', text: 'what?' }, { type: 'image_url', image_url: { url: png } }] }] });
            assert.equal(status, 200);
            assert.deepEqual(stack.fake.state.prompts.at(-1).body.parts[1], { type: 'file', mime: 'image/png', url: png, filename: 'attachment-1' });
        });

        it('auto-rejects OpenCode tool permissions and questions for its sessions', async () => {
            stack.fake.setBehavior(async (ctx) => {
                ctx.emit({ type: 'permission.asked', properties: { id: 'per_test', sessionID: ctx.sessionId, permission: 'bash' } });
                ctx.emit({ type: 'question.asked', properties: { id: 'que_test', sessionID: ctx.sessionId } });
                ctx.emit({ type: 'permission.asked', properties: { id: 'per_foreign', sessionID: 'ses_not_ours' } });
                return streamTurn(ctx, { text: 'done', settleMs: 60 });
            });
            await chat({});
            const reply = await waitFor(() => stack.fake.state.permissionReplies.find((r) => r.id === 'per_test'));
            assert.deepEqual(reply.body, { reply: 'reject', message: TOOL_REJECTION_MESSAGE });
            await waitFor(() => stack.fake.state.questionRejects.includes('que_test'));
            assert.equal(stack.fake.state.permissionReplies.some((r) => r.id === 'per_foreign'), false);
        });
    });

    describe('responses', () => {
        const create = (body, init) => stack.json('/v1/responses', { body: { model: MODEL, ...body }, ...init });

        it('creates, retrieves, chains and deletes responses', async () => {
            const first = await create({ input: 'remember 7', instructions: 'Be brief', metadata: { run: '1' } });
            assert.equal(first.status, 200);
            assert.match(first.body.id, /^resp_/);
            assert.equal(first.body.object, 'response');
            assert.equal(first.body.status, 'completed');
            assert.equal(first.body.instructions, 'Be brief');
            assert.deepEqual(first.body.metadata, { run: '1' });
            assert.equal(first.body.output[0].type, 'message');
            assert.equal(first.body.output[0].content[0].text, 'Echo: remember 7');
            assert.equal(first.body.usage.input_tokens, 12);
            assert.equal(stack.fake.state.prompts.at(-1).body.system, 'Be brief');

            const fetched = await stack.json(`/v1/responses/${first.body.id}`);
            assert.deepEqual(fetched.body, first.body);

            const second = await create({ input: 'what number?', previous_response_id: first.body.id });
            assert.equal(second.status, 200);
            assert.equal(second.body.previous_response_id, first.body.id);
            const transcript = promptText(stack.fake.state.prompts.at(-1).body);
            assert.match(transcript, /<user>\nremember 7\n<\/user>/);
            assert.match(transcript, /<assistant>\nEcho: remember 7\n<\/assistant>/);
            assert.match(transcript, /<user>\nwhat number\?\n<\/user>/);

            const reference = await create({ input: [{ type: 'item_reference', id: first.body.output[0].id }, { role: 'user', content: 'and?' }] });
            assert.equal(reference.status, 200);
            assert.match(promptText(stack.fake.state.prompts.at(-1).body), /<assistant>\nEcho: remember 7\n<\/assistant>/);

            const removed = await stack.json(`/v1/responses/${first.body.id}`, { method: 'DELETE' });
            assert.deepEqual(removed.body, { id: first.body.id, object: 'response', deleted: true });
            assert.equal((await stack.json(`/v1/responses/${first.body.id}`)).status, 404);
            assert.equal((await stack.json(`/v1/responses/${first.body.id}`, { method: 'DELETE' })).status, 404);
            const gone = await create({ input: 'x', previous_response_id: first.body.id });
            assert.equal(gone.status, 400);
            assert.equal(gone.body.error.code, 'previous_response_not_found');
        });

        it('keeps stored responses private to the API key that created them', async () => {
            const mine = await create({ input: 'secret' });
            const id = mine.body.id;
            const theirs = { key: OTHER_KEY };
            assert.equal((await stack.json(`/v1/responses/${id}`, theirs)).status, 404);
            assert.equal((await stack.json(`/v1/responses/${id}`, { method: 'DELETE', ...theirs })).status, 404);
            const chained = await create({ input: 'x', previous_response_id: id }, theirs);
            assert.equal(chained.status, 400);
            assert.equal(chained.body.error.code, 'previous_response_not_found');
            const item = await create({ input: [{ type: 'item_reference', id: mine.body.output[0].id }] }, theirs);
            assert.equal(item.status, 400);
            assert.equal((await stack.json(`/v1/responses/${id}`, { key: KEY })).status, 200, 'still visible to its owner');
        });

        it('does not store responses with store=false', async () => {
            const { body } = await create({ input: 'x', store: false });
            assert.equal(body.store, false);
            assert.equal((await stack.json(`/v1/responses/${body.id}`)).status, 404);
        });

        it('streams Responses events in order', async () => {
            stack.fake.setBehavior((ctx) => streamTurn(ctx, { reasoning: 'hmm', text: 'Hello there', chunks: ['Hello', ' there'] }));
            const response = await stack.request('/v1/responses', { body: { model: MODEL, input: 'hi', stream: true } });
            assert.equal(response.status, 200);
            const frames = await readSse(response);
            const types = frames.map((f) => f.event);
            assert.deepEqual(frames.map((f) => f.data.type), types, 'SSE event names match payload types');
            assert.equal(types[0], 'response.created');
            assert.equal(types[1], 'response.in_progress');
            assert.equal(types.at(-1), 'response.completed');
            assert.deepEqual(frames.map((f) => f.data.sequence_number), frames.map((_, i) => i));
            const text = frames.filter((f) => f.event === 'response.output_text.delta').map((f) => f.data.delta).join('');
            assert.equal(text, 'Hello there');
            assert.ok(types.indexOf('response.reasoning_summary_text.delta') < types.indexOf('response.output_text.delta'));
            const final = frames.at(-1).data.response;
            assert.deepEqual(final.output.map((o) => o.type), ['reasoning', 'message']);
            const stored = await stack.json(`/v1/responses/${final.id}`);
            assert.equal(stored.body.output[1].content[0].text, 'Hello there');
        });

        it('returns function_call items and accepts their outputs', async () => {
            stack.fake.setBehavior(toolBehavior);
            const tools = [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }];
            const first = await create({ input: 'weather?', tools });
            const call = first.body.output.find((o) => o.type === 'function_call');
            assert.equal(call.name, 'get_weather');
            assert.deepEqual(JSON.parse(call.arguments), { city: 'Paris' });
            stack.fake.setBehavior(null);
            const second = await create({ previous_response_id: first.body.id, tools, input: [{ type: 'function_call_output', call_id: call.call_id, output: '22C' }] });
            assert.equal(second.status, 200);
            assert.match(promptText(stack.fake.state.prompts.at(-1).body), new RegExp(`<tool_result name="get_weather" call_id="${call.call_id}">\\n22C`));
        });

        it('emits response.failed when a stream fails', async () => {
            stack.fake.setBehavior((ctx) => streamTurn(ctx, { error: { name: 'ProviderAuthError', data: { message: 'denied' } } }));
            const frames = await readSse(await stack.request('/v1/responses', { body: { model: MODEL, input: 'hi', stream: true } }));
            const failed = frames.at(-1);
            assert.equal(failed.event, 'response.failed');
            assert.equal(failed.data.response.status, 'failed');
            assert.equal(failed.data.response.error.code, 'upstream_auth_failed');
        });

        it('returns errors as JSON when not streaming', async () => {
            stack.fake.setBehavior((ctx) => streamTurn(ctx, { error: { name: 'ContextOverflowError' } }));
            const { status, body } = await create({ input: 'hi' });
            assert.equal(status, 400);
            assert.equal(body.error.code, 'context_length_exceeded');
        });

        it('rejects unsupported options', async () => {
            assert.equal((await create({ input: 'x', background: true })).body.error.param, 'background');
            assert.equal((await create({ input: 'x', conversation: 'c' })).body.error.param, 'conversation');
            assert.equal((await create({})).body.error.param, 'input');
        });
    });
});
