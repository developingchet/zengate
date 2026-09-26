import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createResponseBuilder, responsesUsage } from '../src/openai/response-builder.js';
import { createResponsesStore } from '../src/openai/responses-store.js';
import { ApiError } from '../src/server/errors.js';

const HOUR = 60 * 60 * 1000;
const response = (id, itemIds = [`${id}_item`]) => ({ id, output: itemIds.map((itemId) => ({ id: itemId, type: 'message' })) });
const history = (text) => [{ role: 'user', content: text, media: [] }];

function scoped(maxEntries, owner = 'alice') {
    const store = createResponsesStore({ maxEntries });
    return { store, s: store.scope(owner) };
}

describe('responses store', () => {
    it('saves and returns responses, history and items', () => {
        const { store, s } = scoped(5);
        assert.equal(store.enabled, true);
        s.save(response('r1', ['i1', 'i2']), history('one'));
        assert.equal(s.response('r1').id, 'r1');
        assert.deepEqual(s.history('r1'), history('one'));
        assert.deepEqual(s.item('i2'), { id: 'i2', type: 'message' });
        assert.equal(store.size(), 1);
        assert.equal(s.response('nope'), null);
        assert.equal(s.history('nope'), null);
        assert.equal(s.item('nope'), null);
        assert.ok(Object.isFrozen(s));
    });

    it('hides one owner\'s entries from another', () => {
        const store = createResponsesStore({ maxEntries: 5 });
        const alice = store.scope('alice');
        const bob = store.scope('bob');
        alice.save(response('ra', ['ia']), history('secret'));
        assert.equal(bob.response('ra'), null);
        assert.equal(bob.history('ra'), null);
        assert.equal(bob.item('ia'), null);
        assert.equal(bob.delete('ra'), false);
        assert.ok(alice.response('ra'), 'a foreign delete does not remove the entry');
        assert.ok(store.scope('alice').item('ia'), 'a new scope for the same owner sees it');
        assert.equal(alice.delete('ra'), true);
    });

    it('evicts the least recently used entry and its items', () => {
        const { store, s } = scoped(2);
        s.save(response('a'), history('a'));
        s.save(response('b'), history('b'));
        assert.ok(s.response('a'), 'touch a so b becomes the oldest');
        s.save(response('c'), history('c'));
        assert.equal(store.size(), 2);
        assert.equal(s.response('b'), null);
        assert.equal(s.item('b_item'), null);
        assert.ok(s.response('a'));
        assert.ok(s.response('c'));
    });

    it('expires entries after one hour', (t) => {
        let now = 5_000_000;
        t.mock.method(Date, 'now', () => now);
        const { store, s } = scoped(5);
        s.save(response('old'), history('x'));
        now += HOUR - 1;
        assert.ok(s.response('old'));
        now += 2;
        assert.equal(s.history('old'), null);
        assert.equal(s.item('old_item'), null);
        assert.equal(store.size(), 0);
    });

    it('deletes entries', () => {
        const { s } = scoped(5);
        s.save(response('d'), history('x'));
        assert.equal(s.delete('d'), true);
        assert.equal(s.delete('d'), false);
        assert.equal(s.response('d'), null);
        assert.equal(s.item('d_item'), null);
    });

    it('is disabled with maxEntries 0 and skips oversized histories', () => {
        const disabled = scoped(0);
        assert.equal(disabled.store.enabled, false);
        disabled.s.save(response('x'), history('x'));
        assert.equal(disabled.store.size(), 0);
        const { s } = scoped(5);
        s.save(response('big'), history('x'.repeat(4 * 1024 * 1024 + 1)));
        assert.equal(s.response('big'), null);
    });
});

const USAGE = { input: 10, output: 5, reasoning: 3, cacheRead: 2 };
const callsResult = (overrides = {}) => ({ toolCalls: [], finish: 'stop', usage: USAGE, ...overrides });

function builder(echo = { instructions: null }) {
    const events = [];
    const b = createResponseBuilder({ model: 'big-pickle', echo, emit: (event) => events.push(event) });
    return { b, events, types: () => events.map((e) => e.type) };
}

describe('response builder', () => {
    it('computes Responses usage', () => {
        assert.deepEqual(responsesUsage(USAGE), {
            input_tokens: 12, input_tokens_details: { cached_tokens: 2 },
            output_tokens: 8, output_tokens_details: { reasoning_tokens: 3 }, total_tokens: 20,
        });
    });

    it('emits events in the documented order with monotonic sequence numbers', () => {
        const { b, events, types } = builder({ instructions: 'x', metadata: { k: 'v' } });
        b.start();
        b.reasoningDelta('think');
        b.reasoningDelta('ing');
        b.textDelta('Hel');
        b.textDelta('lo');
        const final = b.finish(callsResult({
            finish: 'tool_calls',
            toolCalls: [
                { id: 'call_1', name: 'get_weather', kind: 'function', arguments: '{"city":"Paris"}' },
                { id: 'call_2', name: 'run_shell', kind: 'custom', arguments: '{"input":"ls -la"}' },
            ],
        }));
        assert.deepEqual(types(), [
            'response.created', 'response.in_progress',
            'response.output_item.added', 'response.reasoning_summary_part.added',
            'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.delta',
            'response.output_item.added', 'response.content_part.added',
            'response.output_text.delta', 'response.output_text.delta',
            'response.reasoning_summary_text.done', 'response.reasoning_summary_part.done', 'response.output_item.done',
            'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
            'response.output_item.added', 'response.function_call_arguments.delta', 'response.function_call_arguments.done', 'response.output_item.done',
            'response.output_item.added', 'response.custom_tool_call_input.delta', 'response.custom_tool_call_input.done', 'response.output_item.done',
            'response.completed',
        ]);
        assert.deepEqual(events.map((e) => e.sequence_number), events.map((_, i) => i));
        assert.equal(events[0].response.status, 'in_progress');
        assert.equal(events[0].response.instructions, 'x');

        assert.equal(final.id, b.id);
        assert.match(final.id, /^resp_[0-9a-f]{32}$/);
        assert.equal(final.object, 'response');
        assert.equal(final.status, 'completed');
        assert.equal(final.model, 'big-pickle');
        assert.deepEqual(final.metadata, { k: 'v' });
        assert.deepEqual(final.output.map((item) => item.type), ['reasoning', 'message', 'function_call', 'custom_tool_call']);
        const [reasoning, message, fn, custom] = final.output;
        assert.deepEqual(reasoning.summary, [{ type: 'summary_text', text: 'thinking' }]);
        assert.equal(message.status, 'completed');
        assert.equal(message.content[0].text, 'Hello');
        assert.deepEqual({ type: fn.type, call_id: fn.call_id, name: fn.name, arguments: fn.arguments, status: fn.status },
            { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}', status: 'completed' });
        assert.match(fn.id, /^fc_/);
        assert.deepEqual({ type: custom.type, call_id: custom.call_id, input: custom.input }, { type: 'custom_tool_call', call_id: 'call_2', input: 'ls -la' });
        assert.match(custom.id, /^ctc_/);
        assert.equal(final.usage.total_tokens, 20);

        const added = events.filter((e) => e.type === 'response.output_item.added');
        assert.equal(added[2].item.status, 'in_progress');
        assert.equal(added[2].item.arguments, '');
        assert.equal(added[3].item.input, '');
        assert.equal(events.at(-1).response, final);
    });

    it('always produces a message item when there is no output at all', () => {
        const { b, types } = builder();
        b.start();
        const final = b.finish(callsResult());
        assert.deepEqual(final.output.map((i) => i.type), ['message']);
        assert.equal(final.output[0].content[0].text, '');
        assert.ok(types().includes('response.output_text.done'));
    });

    it('omits the message item when only tool calls were produced', () => {
        const { b } = builder();
        const final = b.finish(callsResult({ toolCalls: [{ id: 'c', name: 'run_shell', kind: 'custom', arguments: 'not json' }] }));
        assert.deepEqual(final.output.map((i) => i.type), ['custom_tool_call']);
        assert.equal(final.output[0].input, 'not json');
    });

    it('marks length and content_filter finishes as incomplete', () => {
        const length = builder();
        length.b.textDelta('partial');
        const cut = length.b.finish(callsResult({ finish: 'length' }));
        assert.equal(cut.status, 'incomplete');
        assert.deepEqual(cut.incomplete_details, { reason: 'max_output_tokens' });
        assert.equal(length.types().at(-1), 'response.incomplete');
        const filtered = builder().b.finish(callsResult({ finish: 'content_filter' }));
        assert.deepEqual(filtered.incomplete_details, { reason: 'content_filter' });
    });

    it('emits response.failed with a client-safe error', () => {
        const { b, events } = builder();
        b.start();
        const apiError = b.fail(new ApiError(429, 'slow down', { code: 'upstream_rate_limited' }));
        assert.equal(apiError.status, 429);
        const failed = events.at(-1);
        assert.equal(failed.type, 'response.failed');
        assert.equal(failed.response.status, 'failed');
        assert.deepEqual(failed.response.error, { code: 'upstream_rate_limited', message: 'slow down' });
        const generic = builder();
        generic.b.fail(new Error('internal detail'));
        assert.deepEqual(generic.events.at(-1).response.error, { code: 'server_error', message: 'Internal server error.' });
    });

    it('works without an emitter', () => {
        const b = createResponseBuilder({ model: 'm', echo: {} });
        b.start();
        b.textDelta('x');
        assert.equal(b.finish(callsResult()).output[0].content[0].text, 'x');
    });
});
