import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promptText, streamTurn, waitFor } from './helpers/fake-opencode.mjs';
import { readSse, startStack } from './helpers/gateway.mjs';

const MODEL = 'big-pickle';

describe('legacy completions and max_tokens (fake OpenCode backend)', () => {
    let stack;
    before(async () => { stack = await startStack(); });
    after(async () => { await stack?.stop(); });
    afterEach(() => stack.fake.setBehavior(null));

    const complete = (body) => stack.json('/v1/completions', { body: { model: MODEL, prompt: 'Once upon a', ...body } });

    it('continues a prompt as a text_completion', async () => {
        const { status, body } = await complete({ echo: true });
        assert.equal(status, 200);
        assert.equal(body.object, 'text_completion');
        assert.match(body.id, /^cmpl-/);
        assert.deepEqual(body.choices, [{ text: 'Once upon aEcho: Once upon a', index: 0, logprobs: null, finish_reason: 'stop' }]);
        assert.equal(body.usage.total_tokens, 17);
        const sent = stack.fake.state.prompts.at(-1).body;
        assert.match(sent.system, /^Continue the text/);
        assert.equal(promptText(sent), 'Once upon a');
    });

    it('answers several prompts and n per prompt with ordered choices', async () => {
        const { body } = await complete({ prompt: ['a', 'b'], n: 2 });
        assert.deepEqual(body.choices.map((c) => [c.index, c.text]), [[0, 'Echo: a'], [1, 'Echo: a'], [2, 'Echo: b'], [3, 'Echo: b']]);
        assert.equal((await complete({ prompt: ['a', 'b', 'c'], n: 2 })).status, 400);
    });

    it('streams text_completion chunks and usage', async () => {
        const response = await stack.request('/v1/completions', { body: { model: MODEL, prompt: 'hi', stream: true, stream_options: { include_usage: true } } });
        const events = await readSse(response);
        assert.equal(events.at(-1).data, '[DONE]');
        const chunks = events.slice(0, -1).map((e) => e.data);
        assert.ok(chunks.every((c) => c.object === 'text_completion'));
        assert.equal(chunks.filter((c) => c.choices.length).map((c) => c.choices[0].text).join(''), 'Echo: hi');
        assert.equal(chunks.at(-2).choices[0].finish_reason, 'stop');
        assert.equal(chunks.at(-1).usage.total_tokens, 17);
    });

    it('rejects what it cannot do', async () => {
        for (const body of [{ prompt: [1, 2] }, { suffix: 'end' }, { logprobs: 2 }, { prompt: undefined }, { max_tokens: 0 }]) {
            const { status } = await complete(body);
            assert.equal(status, 400, JSON.stringify(body));
        }
    });

    it('explains that embeddings are unavailable', async () => {
        const { status, body } = await stack.json('/v1/embeddings', { body: { model: 'x', input: 'y' } });
        assert.equal(status, 404);
        assert.equal(body.error.code, 'unsupported_endpoint');
    });

    it('cuts the answer at max_tokens (about four characters each) and reports length', async () => {
        stack.fake.setBehavior((ctx) => streamTurn(ctx, { text: 'abcdefghijklmnopqrstuvwxyz', chunks: ['abcdef', 'ghijklmnop', 'qrstuvwxyz'] }));
        const aborted = stack.fake.state.aborted.length;
        const chat = await stack.json('/v1/chat/completions', { body: { model: MODEL, max_tokens: 2, messages: [{ role: 'user', content: 'go' }] } });
        assert.equal(chat.body.choices[0].message.content, 'abcdefgh');
        assert.equal(chat.body.choices[0].finish_reason, 'length');
        assert.equal(chat.headers.get('x-gateway-ignored-params'), null);
        await waitFor(() => stack.fake.state.aborted.length > aborted);

        const newer = await stack.json('/v1/chat/completions', { body: { model: MODEL, max_completion_tokens: 3, max_tokens: 1, messages: [{ role: 'user', content: 'go' }] } });
        assert.equal(newer.body.choices[0].message.content, 'abcdefghijkl', 'max_completion_tokens wins');

        const responses = await stack.json('/v1/responses', { body: { model: MODEL, input: 'go', max_output_tokens: 1 } });
        assert.equal(responses.body.status, 'incomplete');
        assert.deepEqual(responses.body.incomplete_details, { reason: 'max_output_tokens' });
        assert.equal(responses.body.output.find((item) => item.type === 'message').content[0].text, 'abcd');

        const legacy = await complete({ max_tokens: 4 });
        assert.equal(legacy.body.choices[0].text, 'abcdefghijklmnop');
        assert.equal(legacy.body.choices[0].finish_reason, 'length');
    });

    it('estimates usage for a reply cut at max_tokens', async () => {
        const messages = [{ role: 'user', content: 'go' }];
        const whole = await stack.json('/v1/chat/completions', { body: { model: MODEL, messages } });
        stack.fake.setBehavior((ctx) => streamTurn(ctx, { text: 'abcdefghijklmnopqrstuvwxyz', chunks: ['abcdef', 'ghijklmnop', 'qrstuvwxyz'] }));
        const { body } = await stack.json('/v1/chat/completions', { body: { model: MODEL, max_tokens: 2, messages } });
        assert.equal(body.choices[0].finish_reason, 'length');
        assert.equal(body.usage.completion_tokens, 2);
        assert.equal(body.usage.prompt_tokens, whole.body.usage.prompt_tokens, 'the same prompt is estimated at what OpenCode last measured');
    });

    it('counts reasoning against max_completion_tokens but not max_tokens', async () => {
        stack.fake.setBehavior((ctx) => streamTurn(ctx, {
            reasoning: 'thinking it over', reasoningChunks: ['thinking', ' it over'], text: 'abcdefghijklmnopqrstuvwxyz', chunks: ['abcdef', 'ghijklmnop', 'qrstuvwxyz'],
        }));
        const messages = [{ role: 'user', content: 'go' }];
        const completion = await stack.json('/v1/chat/completions', { body: { model: MODEL, max_completion_tokens: 3, messages } });
        assert.equal(completion.body.choices[0].finish_reason, 'length');
        assert.equal(completion.body.choices[0].message.reasoning_content, 'thinking it ');
        assert.equal(completion.body.choices[0].message.content, '');

        const legacy = await stack.json('/v1/chat/completions', { body: { model: MODEL, max_tokens: 3, messages } });
        assert.equal(legacy.body.choices[0].message.reasoning_content, 'thinking it over');
        assert.equal(legacy.body.choices[0].message.content, 'abcdefghijkl');
    });

    it('cuts streamed answers at max_tokens', async () => {
        stack.fake.setBehavior((ctx) => streamTurn(ctx, { text: 'abcdefghijklmnopqrstuvwxyz', chunks: ['abcdef', 'ghijklmnop', 'qrstuvwxyz'] }));
        const chat = await readSse(await stack.request('/v1/chat/completions', { body: { model: MODEL, stream: true, max_tokens: 2, messages: [{ role: 'user', content: 'go' }] } }));
        const chunks = chat.slice(0, -1).map((e) => e.data);
        assert.equal(chunks.map((c) => c.choices[0]?.delta.content ?? '').join(''), 'abcdefgh');
        assert.equal(chunks.at(-1).choices[0].finish_reason, 'length');

        const legacy = await readSse(await stack.request('/v1/completions', { body: { model: MODEL, prompt: 'x', stream: true, max_tokens: 3 } }));
        const texts = legacy.slice(0, -1).map((e) => e.data.choices[0]);
        assert.equal(texts.map((c) => c.text).join(''), 'abcdefghijkl');
        assert.equal(texts.at(-1).finish_reason, 'length');
    });

    it('drops a function call that max_tokens cut off instead of showing its markup', async () => {
        const reply = 'ok <tool_call>{"name":"f","arguments":{"city":"Paris and some more text"}}</tool_call>';
        stack.fake.setBehavior((ctx) => streamTurn(ctx, { text: reply, chunks: [reply.slice(0, 10), reply.slice(10, 30), reply.slice(30)] }));
        const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }];
        const cut = await stack.json('/v1/chat/completions', { body: { model: MODEL, max_tokens: 5, tools, messages: [{ role: 'user', content: 'go' }] } });
        assert.equal(cut.body.choices[0].finish_reason, 'length');
        assert.equal(cut.body.choices[0].message.content, 'ok ');
        assert.equal(cut.body.choices[0].message.tool_calls, undefined);

        const whole = await stack.json('/v1/chat/completions', { body: { model: MODEL, max_tokens: 40, tools, messages: [{ role: 'user', content: 'go' }] } });
        assert.equal(whole.body.choices[0].finish_reason, 'tool_calls');
        assert.equal(whole.body.choices[0].message.tool_calls[0].function.name, 'f');
    });

    it('applies stop sequences to legacy completions', async () => {
        stack.fake.setBehavior((ctx) => streamTurn(ctx, { text: 'one two three' }));
        const { body } = await complete({ stop: [' two'] });
        assert.equal(body.choices[0].text, 'one');
        assert.equal(body.choices[0].finish_reason, 'stop');
    });

    it('lists only header-safe ignored parameter names', async () => {
        const extra = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`p${i}`, 1]));
        const { status, headers } = await stack.json('/v1/chat/completions', { body: { model: MODEL, '€': 1, 'a b': 2, ...extra, messages: [{ role: 'user', content: 'go' }] } });
        assert.equal(status, 200);
        const listed = headers.get('x-gateway-ignored-params').split(',');
        assert.equal(listed.length, 32);
        assert.ok(listed.every((name) => /^p\d+$/.test(name)));
    });

    it('leaves short answers alone', async () => {
        const { body } = await stack.json('/v1/chat/completions', { body: { model: MODEL, max_tokens: 100, messages: [{ role: 'user', content: 'go' }] } });
        assert.equal(body.choices[0].message.content, 'Echo: go');
        assert.equal(body.choices[0].finish_reason, 'stop');
    });
});
