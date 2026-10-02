import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chatUsage, generate } from '../src/openai/generate.js';
import { ApiError } from '../src/server/errors.js';

const ZERO = { input: 0, output: 0, reasoning: 0, cacheRead: 0 };
const USAGE = { input: 10, output: 4, reasoning: 1, cacheRead: 2 };
const TOOLS = [{ name: 'get_weather', kind: 'function' }];
const BLOCK = '<tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>';

/**
 * A runner double: each run() consumes the next script entry, streams its
 * deltas (stopping early if the signal aborts, like the real runner) and
 * returns its result.
 */
function fakeRunner(scripts) {
    const calls = [];
    return {
        calls,
        async run(prompt, { signal, onDelta }) {
            const script = scripts[calls.length];
            calls.push({ prompt, signal });
            if (!script) throw new Error('unexpected run');
            for (const [kind, text] of script.deltas || []) {
                if (signal.aborted) throw signal.reason;
                onDelta(kind, text);
            }
            if (signal.aborted) throw signal.reason;
            if (script.throws) throw script.throws;
            return { text: '', reasoning: '', usage: USAGE, finish: 'stop', ...script.result };
        },
    };
}

const request = (overrides = {}) => ({ tools: [], toolChoice: 'auto', stop: [], ...overrides });
const PROMPT = { system: 'base system', parts: [{ type: 'text', text: 'hi' }] };

async function gen(scripts, requestOverrides, { signal = new AbortController().signal, prompt = PROMPT } = {}) {
    const runner = fakeRunner(scripts);
    const texts = [];
    const reasoning = [];
    const result = await generate({
        runner, prompt, request: request(requestOverrides), signal,
        onText: (t) => texts.push(t), onReasoning: (t) => reasoning.push(t),
    });
    return { result, texts, reasoning, runner };
}

describe('generate', () => {
    it('streams plain text and reasoning', async () => {
        const { result, texts, reasoning } = await gen([{ deltas: [['reasoning', 'hmm'], ['text', 'Hel'], ['text', 'lo']], result: { finish: 'length' } }]);
        assert.equal(result.content, 'Hello');
        assert.equal(result.reasoning, 'hmm');
        assert.deepEqual(texts, ['Hel', 'lo']);
        assert.deepEqual(reasoning, ['hmm']);
        assert.equal(result.finish, 'length');
        assert.deepEqual(result.usage, USAGE);
        assert.deepEqual(result.toolCalls, []);
        assert.equal(result.nativeToolAttempt, null);
    });

    it('works with the default callbacks', async () => {
        const runner = fakeRunner([{ deltas: [['text', 'x'], ['reasoning', 'y']] }]);
        const result = await generate({ runner, prompt: PROMPT, request: request(), signal: new AbortController().signal });
        assert.equal(result.content, 'x');
    });

    it('applies stop sequences and aborts the run', async () => {
        const { result, texts, runner } = await gen([{ deltas: [['text', 'abc EN'], ['text', 'D more'], ['text', 'never']], result: { finish: 'length' } }], { stop: ['END'] });
        assert.equal(result.content, 'abc ');
        assert.equal(texts.join(''), 'abc ');
        assert.equal(result.finish, 'stop');
        const { input, ...rest } = result.usage;
        assert.deepEqual(rest, { output: 1, reasoning: 0, cacheRead: 0 }, 'a cut-off run estimates its output');
        assert.ok(Number.isInteger(input) && input > 0, 'and its prompt');
        assert.equal(runner.calls[0].signal.aborted, true);
    });

    it('releases held stop-prefix text at the end', async () => {
        const { result } = await gen([{ deltas: [['text', 'value E']] }], { stop: ['END'] });
        assert.equal(result.content, 'value E');
        assert.equal(result.finish, 'stop');
    });

    it('extracts tool calls and keeps preceding text', async () => {
        const { result, texts } = await gen([{ deltas: [['text', 'Checking. <tool'], ['text', `${BLOCK.slice(5)}`]] }], { tools: TOOLS });
        assert.equal(result.content, 'Checking. ');
        assert.deepEqual(texts, ['Checking. ']);
        assert.equal(result.finish, 'tool_calls');
        assert.equal(result.toolCalls.length, 1);
        assert.equal(result.toolCalls[0].name, 'get_weather');
        assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), { city: 'Paris' });
    });

    it('does not parse calls when tool_choice is none', async () => {
        const { result } = await gen([{ deltas: [['text', BLOCK]] }], { tools: TOOLS, toolChoice: 'none' });
        assert.equal(result.content, BLOCK);
        assert.deepEqual(result.toolCalls, []);
    });

    it('emits structured output', async () => {
        const { result, texts } = await gen([{ result: { structured: { a: 1 } } }]);
        assert.equal(result.content, '{"a":1}');
        assert.deepEqual(texts, ['{"a":1}']);
        const asString = await gen([{ result: { structured: '{"b":2}' } }]);
        assert.equal(asString.result.content, '{"b":2}');
    });

    it('holds back streamed prose under native structured output', async () => {
        const FORMAT_PROMPT = { ...PROMPT, format: { type: 'json_schema', schema: { type: 'object' } } };
        const structured = await gen([{ deltas: [['text', 'Sure, here'], ['reasoning', 'r'], ['text', ' it is']], result: { structured: { a: 1 } } }], {}, { prompt: FORMAT_PROMPT });
        assert.equal(structured.result.content, '{"a":1}');
        assert.deepEqual(structured.texts, ['{"a":1}']);
        assert.deepEqual(structured.reasoning, ['r'], 'reasoning still streams');
        const heldOnly = await gen([{ deltas: [['text', '{"b"'], ['text', ':2}']] }], {}, { prompt: FORMAT_PROMPT });
        assert.equal(heldOnly.result.content, '{"b":2}');
        assert.deepEqual(heldOnly.texts, ['{"b":2}'], 'held text is released once, at the end');
        const empty = await gen([{}], {}, { prompt: FORMAT_PROMPT });
        assert.equal(empty.result.content, '');
    });

    it('streams text normally without a native format', async () => {
        const { result, texts } = await gen([{ deltas: [['text', 'a'], ['text', 'b']] }]);
        assert.deepEqual(texts, ['a', 'b']);
        assert.equal(result.content, 'ab');
    });

    it('propagates runner errors', async () => {
        const error = new ApiError(502, 'upstream');
        await assert.rejects(gen([{ throws: error }]), (e) => e === error);
    });

    it('retries once when tool_choice requires a call but the model answered in prose', async () => {
        const { result, texts, runner } = await gen([
            { deltas: [['text', 'I would call it']] },
            { deltas: [['text', BLOCK]] },
        ], { tools: TOOLS, toolChoice: 'required' });
        assert.equal(runner.calls.length, 2);
        assert.match(runner.calls[1].prompt.system, /^base system\n\nTo call a function, write a <tool_call>/);
        assert.equal(result.finish, 'tool_calls');
        assert.equal(result.toolCalls.length, 1);
        assert.equal(result.content, 'I would call it');
        assert.deepEqual(texts, ['I would call it']);
        assert.deepEqual(result.usage, { input: 20, output: 8, reasoning: 2, cacheRead: 4 });
    });

    it('separates retry text from the first attempt', async () => {
        const { result, texts } = await gen([
            { deltas: [['text', 'First'], ['reasoning', 'r1']] },
            { deltas: [['text', 'Second'], ['reasoning', 'r2']] },
        ], { tools: TOOLS, toolChoice: { name: 'get_weather' } }, { prompt: { parts: [] } });
        assert.equal(result.content, 'First\n\nSecond');
        assert.deepEqual(texts, ['First', '\n\n', 'Second']);
        assert.equal(result.reasoning, 'r1r2');
        assert.equal(result.finish, 'stop');
    });

    it('retries after a native attempt to call a client function', async () => {
        const { result, runner } = await gen([
            { result: { nativeToolAttempt: 'get_weather', usage: ZERO } },
            { deltas: [['text', BLOCK]] },
        ], { tools: TOOLS });
        assert.equal(runner.calls.length, 2);
        assert.match(runner.calls[1].prompt.system, /previous attempt to call "get_weather" as a native tool failed/);
        assert.equal(result.toolCalls.length, 1);
        assert.deepEqual(result.usage, USAGE);
    });

    it('tells the model a nonexistent tool does not exist when there are no client tools', async () => {
        const { result, runner } = await gen([
            { result: { nativeToolAttempt: 'bash', usage: ZERO } },
            { deltas: [['text', 'Direct answer']] },
        ], {}, { prompt: { parts: [] } });
        assert.equal(runner.calls[1].prompt.system, 'There is no tool named "bash". Answer directly without calling tools.');
        assert.equal(result.content, 'Direct answer');
    });

    it('does not retry when the request was aborted', async () => {
        const controller = new AbortController();
        const runner = {
            calls: 0,
            async run() {
                this.calls += 1;
                controller.abort();
                return { text: '', reasoning: '', usage: ZERO, finish: 'stop' };
            },
        };
        const result = await generate({ runner, prompt: PROMPT, request: request({ tools: TOOLS, toolChoice: 'required' }), signal: controller.signal });
        assert.equal(runner.calls, 1);
        assert.deepEqual(result.toolCalls, []);
    });

    it('forwards an already-aborted signal to the runner', async () => {
        const controller = new AbortController();
        controller.abort(new ApiError(499, 'gone'));
        await assert.rejects(gen([{ deltas: [['text', 'x']] }], {}, { signal: controller.signal }), { status: 499 });
    });

    it('does not retry after a successful call or without a reason to', async () => {
        const auto = await gen([{ deltas: [['text', 'prose']] }], { tools: TOOLS });
        assert.equal(auto.runner.calls.length, 1);
        const forcedOk = await gen([{ deltas: [['text', BLOCK]] }], { tools: TOOLS, toolChoice: 'required' });
        assert.equal(forcedOk.runner.calls.length, 1);
    });
});

describe('chatUsage', () => {
    it('sums usages into the Chat Completions shape', () => {
        assert.deepEqual(chatUsage([USAGE, { input: 1, output: 1, reasoning: 0, cacheRead: 0 }]), {
            prompt_tokens: 13, completion_tokens: 6, total_tokens: 19,
            prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 },
        });
        assert.equal(chatUsage([]).total_tokens, 0);
    });
});
