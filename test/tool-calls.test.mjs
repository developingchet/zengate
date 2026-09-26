import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createToolCallParser, newCallId, renderToolCall, toolInstructions } from '../src/openai/tool-calls.js';

const TOOLS = [
    { name: 'get_weather', description: 'Weather by city', parameters: { type: 'object', properties: { city: { type: 'string' } } }, kind: 'function' },
    { name: 'lookup', kind: 'function' },
    { name: 'run_shell', description: 'Free-form command', kind: 'custom' },
];

/** Feed chunks through a fresh parser; returns everything visible plus the final calls. */
function parse(chunks, tools = TOOLS) {
    const parser = createToolCallParser(tools);
    const pieces = [];
    for (const chunk of [].concat(chunks)) pieces.push(parser.push(chunk));
    const finished = parser.finish();
    return { streamed: pieces, visible: pieces.join('') + finished.text, calls: finished.calls, tail: finished.text };
}

const argsOf = (call) => JSON.parse(call.arguments);

describe('tool call parser', () => {
    it('parses a <tool_call> JSON block', () => {
        const { visible, calls } = parse('<tool_call>{"name": "get_weather", "arguments": {"city": "Paris"}}</tool_call>');
        assert.equal(visible, '');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, 'get_weather');
        assert.equal(calls[0].kind, 'function');
        assert.deepEqual(argsOf(calls[0]), { city: 'Paris' });
        assert.match(calls[0].id, /^call_[0-9a-f]{24}$/);
    });

    it('keeps text before the call and drops whitespace around blocks', () => {
        const { streamed, visible, calls } = parse('Let me check. <tool_call>{"name":"lookup","arguments":{}}</tool_call>\n');
        assert.equal(streamed[0], 'Let me check. ');
        assert.equal(visible, 'Let me check. ');
        assert.equal(calls.length, 1);
        assert.deepEqual(argsOf(calls[0]), {});
    });

    it('parses several <tool_call> blocks', () => {
        const text = '<tool_call>{"name":"lookup","arguments":{"q":1}}</tool_call>\n<tool_call>{"name":"get_weather","arguments":{"city":"Oslo"}}</tool_call>';
        const { calls } = parse(text);
        assert.deepEqual(calls.map((c) => c.name), ['lookup', 'get_weather']);
        assert.notEqual(calls[0].id, calls[1].id);
    });

    it('parses <function_calls> holding a JSON array', () => {
        const { calls } = parse('<function_calls>[{"name":"lookup","arguments":{"a":1}},{"name":"get_weather","arguments":{"city":"Rome"}}]</function_calls>');
        assert.deepEqual(calls.map((c) => c.name), ['lookup', 'get_weather']);
        assert.deepEqual(argsOf(calls[1]), { city: 'Rome' });
    });

    it('parses <tool_calls> with an array and alternate field spellings', () => {
        const { calls } = parse('<tool_calls>[{"function":{"name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}},{"name":"get_weather","parameters":{"city":"Lima"}}]</tool_calls>');
        assert.deepEqual(calls.map((c) => c.name), ['lookup', 'get_weather']);
        assert.deepEqual(argsOf(calls[0]), { q: 'x' });
        assert.deepEqual(argsOf(calls[1]), { city: 'Lima' });
    });

    it('parses <function_call> and fenced JSON bodies', () => {
        const { calls } = parse('<function_call>```json\n{"name":"lookup","arguments":{"n":2}}\n```</function_call>');
        assert.equal(calls.length, 1);
        assert.deepEqual(argsOf(calls[0]), { n: 2 });
    });

    it('parses <function=name>{json}</function>', () => {
        const { calls, visible } = parse('<function=get_weather>{"city": "Rome"}</function>');
        assert.equal(visible, '');
        assert.equal(calls[0].name, 'get_weather');
        assert.deepEqual(argsOf(calls[0]), { city: 'Rome' });
    });

    it('parses <function=name> with <parameter=key> pairs', () => {
        const { calls } = parse('<function=get_weather>\n<parameter=city>\nRome\n</parameter>\n<parameter=days>3</parameter>\n<parameter=opts>{"metric":true}</parameter>\n</function>');
        assert.deepEqual(argsOf(calls[0]), { city: 'Rome', days: 3, opts: { metric: true } });
    });

    it('parses <function=name></function> with an empty body as no arguments', () => {
        const { calls } = parse('<function=lookup></function>');
        assert.deepEqual(argsOf(calls[0]), {});
    });

    it('leaves <function=name> with an unparseable body as text', () => {
        const { calls, visible } = parse('<function=lookup>not json</function>');
        assert.equal(calls.length, 0);
        assert.equal(visible, '<function=lookup>not json</function>');
    });

    it('handles openers split across chunk boundaries', () => {
        const { streamed, calls, visible } = parse(['Hi <to', 'ol_c', 'all>{"name":"get_weather","arg', 'uments":{"city":"Bern"}}</tool', '_call>']);
        assert.deepEqual(streamed, ['Hi ', '', '', '', '']);
        assert.equal(visible, 'Hi ');
        assert.deepEqual(argsOf(calls[0]), { city: 'Bern' });
    });

    it('holds back a partial <function= opener, then releases non-openers', () => {
        const parser = createToolCallParser(TOOLS);
        assert.equal(parser.push('a <function=get_w'), 'a ');
        assert.equal(parser.push('eather>{"city":"Q"}</function>'), '');
        assert.equal(parser.finish().calls[0].name, 'get_weather');

        const other = createToolCallParser(TOOLS);
        assert.equal(other.push('x <'), 'x ');
        assert.equal(other.push('b> and more'), '<b> and more');
        assert.deepEqual(other.finish(), { text: '', calls: [] });
    });

    it('returns a held partial opener as text at the end', () => {
        const { visible, calls } = parse(['text <tool']);
        assert.equal(visible, 'text <tool');
        assert.deepEqual(calls, []);
    });

    it('does not hold a "<" that is far back in the text', () => {
        const parser = createToolCallParser(TOOLS);
        const long = `<${'x'.repeat(200)}`;
        assert.equal(parser.push(long), long);
    });

    it('keeps blocks naming unknown tools as visible text', () => {
        const block = '<tool_call>{"name":"rm_rf","arguments":{}}</tool_call>';
        const { calls, visible } = parse(`Before ${block} after`);
        assert.equal(calls.length, 0);
        assert.equal(visible, `Before ${block} after`);
    });

    it('keeps invalid JSON and non-object arguments as text', () => {
        const bad = '<tool_call>{"name":"lookup", "arguments": {oops}}</tool_call>';
        assert.equal(parse(bad).calls.length, 0);
        assert.equal(parse(bad).visible, bad);
        const arrayArgs = '<tool_call>{"name":"lookup","arguments":[1,2]}</tool_call>';
        assert.equal(parse(arrayArgs).calls.length, 0);
        const stringArgs = '<tool_call>{"name":"lookup","arguments":"not json"}</tool_call>';
        assert.equal(parse(stringArgs).calls.length, 0);
        const empty = '<tool_call></tool_call>';
        assert.equal(parse(empty).visible, empty);
    });

    it('parses an unterminated block at the end of the output', () => {
        const { calls } = parse('<tool_call>{"name":"lookup","arguments":{"k":"v"}}');
        assert.deepEqual(argsOf(calls[0]), { k: 'v' });
    });

    it('keeps a mix of parsed and unparseable blocks', () => {
        const { calls, tail } = parse('<tool_call>{"name":"nope"}</tool_call><tool_call>{"name":"lookup","arguments":{}}</tool_call>');
        assert.equal(calls.length, 1);
        assert.equal(tail, '<tool_call>{"name":"nope"}</tool_call>');
    });

    it('handles strings containing braces and escaped quotes', () => {
        const { calls } = parse('<tool_call>{"name":"lookup","arguments":{"q":"a } \\" { b"}}</tool_call>');
        assert.deepEqual(argsOf(calls[0]), { q: 'a } " { b' });
    });

    describe('custom tools', () => {
        it('wraps a raw string as {input}', () => {
            const { calls } = parse('<tool_call>{"name":"run_shell","arguments":"ls -la"}</tool_call>');
            assert.equal(calls[0].kind, 'custom');
            assert.deepEqual(argsOf(calls[0]), { input: 'ls -la' });
        });

        it('accepts an input field', () => {
            const { calls } = parse('<tool_call>{"name":"run_shell","input":"echo hi"}</tool_call>');
            assert.deepEqual(argsOf(calls[0]), { input: 'echo hi' });
        });

        it('keeps {input} objects and stringifies other shapes', () => {
            assert.deepEqual(argsOf(parse('<tool_call>{"name":"run_shell","arguments":{"input":"pwd"}}</tool_call>').calls[0]), { input: 'pwd' });
            assert.deepEqual(argsOf(parse('<tool_call>{"name":"run_shell","arguments":{"cmd":"pwd"}}</tool_call>').calls[0]), { input: '{"cmd":"pwd"}' });
            assert.deepEqual(argsOf(parse('<tool_call>{"name":"run_shell","arguments":"{\\"input\\":\\"x\\"}"}</tool_call>').calls[0]), { input: 'x' });
        });
    });
});

describe('toolInstructions / renderToolCall / newCallId', () => {
    it('is empty without tools or with tool_choice none', () => {
        assert.equal(toolInstructions([], 'auto', true), '');
        assert.equal(toolInstructions(TOOLS, 'none', true), '');
    });

    it('describes each tool and the calling protocol', () => {
        const text = toolInstructions(TOOLS, 'auto', true);
        assert.match(text, /# Client functions/);
        assert.match(text, /<tool_call>\{"name": "<function name>"/);
        assert.match(text, /- get_weather: Weather by city/);
        assert.match(text, /arguments JSON Schema: \{"type":"object","properties":\{"city"/);
        assert.match(text, /- lookup\n {2}arguments JSON Schema: \{"type":"object","properties":\{\}\}/);
        assert.match(text, /- run_shell: Free-form command\n {2}arguments: \{"input"/);
        assert.match(text, /several blocks/);
        assert.doesNotMatch(text, /must call/);
    });

    it('reflects parallel and forced choices', () => {
        assert.match(toolInstructions(TOOLS, 'auto', false), /at most one function/);
        assert.match(toolInstructions(TOOLS, 'required', true), /must call at least one/);
        assert.match(toolInstructions(TOOLS, { name: 'lookup' }, true), /must call the function "lookup"/);
    });

    it('renders past calls in the same syntax', () => {
        assert.equal(renderToolCall({ name: 'lookup', arguments: '{"a":1}' }), '<tool_call>{"name":"lookup","arguments":{"a":1}}</tool_call>');
        assert.equal(renderToolCall({ name: 'lookup', arguments: 'raw' }), '<tool_call>{"name":"lookup","arguments":"raw"}</tool_call>');
    });

    it('makes unique call ids', () => {
        const ids = new Set(Array.from({ length: 20 }, newCallId));
        assert.equal(ids.size, 20);
    });
});
