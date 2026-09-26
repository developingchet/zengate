import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseInputItems, parseResponsesRequest } from '../src/openai/responses-request.js';

const media = { maxBytes: 1024 * 1024 };
const PRIOR = [{ role: 'user', content: 'earlier', media: [] }, { role: 'assistant', content: 'reply', media: [], toolCalls: [] }];
const store = {
    history: (id) => (id === 'resp_known' ? PRIOR : null),
    item: (id) => (id === 'msg_known' ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'stored text' }] } : null),
};
const parse = (body) => parseResponsesRequest({ model: 'big-pickle', input: 'hi', ...body }, media, store);

function invalid(fn, { param, code, message } = {}) {
    assert.throws(fn, (error) => {
        assert.equal(error.status, 400);
        if (param !== undefined) assert.equal(error.param, param);
        if (code !== undefined) assert.equal(error.code, code);
        if (message) assert.match(error.message, message);
        return true;
    });
}

describe('parseResponsesRequest', () => {
    it('turns a string input into one user message with defaults', () => {
        const request = parse({});
        assert.deepEqual(request.messages, [{ role: 'user', content: 'hi', media: [] }]);
        assert.deepEqual(request.inputMessages, request.messages);
        assert.deepEqual(request.history, []);
        assert.equal(request.toolChoice, 'auto');
        assert.equal(request.n, 1);
        assert.deepEqual(request.stop, []);
        assert.equal(request.stream, false);
        assert.equal(request.store, true);
        assert.equal(request.format, null);
        assert.equal(request.echo.instructions, null);
        assert.deepEqual(request.echo.text, { format: { type: 'text' } });
        assert.equal(request.echo.truncation, 'disabled');
        assert.deepEqual(request.echo.metadata, {});
    });

    it('validates required fields', () => {
        invalid(() => parseResponsesRequest('x', media, store), { message: /JSON object/ });
        invalid(() => parseResponsesRequest({ input: 'x' }, media, store), { param: 'model' });
        invalid(() => parseResponsesRequest({ model: 'm' }, media, store), { param: 'input' });
        invalid(() => parse({ instructions: 5 }), { param: 'instructions' });
        invalid(() => parse({ input: 5 }), { param: 'input' });
    });

    it('rejects unsupported background, conversation and prompt templates', () => {
        invalid(() => parse({ background: true }), { param: 'background', code: 'unsupported_parameter' });
        invalid(() => parse({ conversation: 'conv_1' }), { param: 'conversation', code: 'unsupported_parameter' });
        invalid(() => parse({ prompt: { id: 'pmpt_1' } }), { param: 'prompt', code: 'unsupported_parameter' });
        assert.doesNotThrow(() => parse({ background: false }));
    });

    it('prepends instructions as a system message and echoes request fields', () => {
        const request = parse({
            instructions: 'Be terse', metadata: { a: '1' }, temperature: 0.5, top_p: 0.9, max_output_tokens: 50, user: 'u',
            reasoning: { effort: 'high', summary: 'auto' }, store: false, stream: true, parallel_tool_calls: false,
            text: { format: { type: 'json_schema', name: 'x', schema: { type: 'object' } } }, truncation: 'auto',
        });
        assert.deepEqual(request.messages[0], { role: 'system', content: 'Be terse', media: [] });
        assert.equal(request.reasoningEffort, 'high');
        assert.equal(request.store, false);
        assert.equal(request.stream, true);
        assert.equal(request.parallelToolCalls, false);
        assert.deepEqual(request.format, { type: 'json_schema', name: 'x', schema: { type: 'object' } });
        assert.equal(request.echo.instructions, 'Be terse');
        assert.deepEqual(request.echo.metadata, { a: '1' });
        assert.deepEqual(request.echo.reasoning, { effort: 'high', summary: 'auto' });
        assert.equal(request.echo.temperature, 0.5);
        assert.equal(request.echo.max_output_tokens, 50);
        assert.equal(request.echo.store, false);
        assert.equal(request.echo.truncation, 'auto');
        assert.deepEqual(request.ignored.sort(), ['max_output_tokens', 'temperature', 'top_p', 'truncation', 'user']);
    });

    it('parses function and custom tools, ignoring hosted ones', () => {
        const request = parse({
            tools: [
                { type: 'function', name: 'get_weather', description: 'w', parameters: { type: 'object' } },
                { type: 'custom', name: 'run_shell' },
                { type: 'web_search' },
                {},
            ],
            tool_choice: { type: 'function', name: 'get_weather' },
        });
        assert.deepEqual(request.tools, [
            { name: 'get_weather', description: 'w', parameters: { type: 'object' }, kind: 'function' },
            { name: 'run_shell', description: '', parameters: undefined, kind: 'custom' },
        ]);
        assert.deepEqual(request.toolChoice, { name: 'get_weather' });
        assert.ok(request.ignored.includes('tools.web_search'));
        assert.ok(request.ignored.includes('tools.unknown'));
        assert.equal(request.echo.tools.length, 4);
        invalid(() => parse({ tools: 'x' }), { param: 'tools' });
        invalid(() => parse({ tools: [{ type: 'function', name: 'bad name' }] }), { param: 'tools[0].name' });
    });

    it('loads history from previous_response_id', () => {
        const request = parse({ previous_response_id: 'resp_known', instructions: 'sys' });
        assert.deepEqual(request.history, PRIOR);
        assert.deepEqual(request.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
        assert.equal(request.echo.previous_response_id, 'resp_known');
    });

    it('fails clearly when previous_response_id is unknown', () => {
        invalid(() => parse({ previous_response_id: 'resp_missing' }), { param: 'previous_response_id', code: 'previous_response_not_found' });
    });

    it('resolves item_reference entries', () => {
        const request = parse({ input: [{ type: 'item_reference', id: 'msg_known' }, { role: 'user', content: 'more' }] });
        assert.deepEqual(request.messages[0], { role: 'assistant', content: 'stored text', media: [], toolCalls: [] });
        invalid(() => parse({ input: [{ type: 'item_reference', id: 'msg_missing' }] }), { param: 'input[0]', message: /not found/ });
    });
});

describe('parseInputItems', () => {
    const resolve = () => null;
    const items = (input) => parseInputItems(input, media, resolve);

    it('maps developer to system and flattens content parts', () => {
        const messages = items([
            { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] },
            { role: 'user', content: [{ type: 'input_text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'refusal', refusal: 'c' }] },
            { role: 'assistant', content: [{ type: 'output_text', text: 'd' }, { type: 'summary_text', text: 'e' }] },
        ]);
        assert.deepEqual(messages, [
            { role: 'system', content: 'rules', media: [] },
            { role: 'user', content: 'abc', media: [] },
            { role: 'assistant', content: 'de', media: [], toolCalls: [] },
        ]);
    });

    it('groups consecutive calls into one assistant turn and keeps outputs', () => {
        const messages = items([
            { role: 'user', content: 'weather in two cities' },
            { type: 'function_call', call_id: 'c1', name: 'get_weather', arguments: '{"city":"A"}' },
            { type: 'function_call', call_id: 'c2', name: 'get_weather' },
            { type: 'reasoning', summary: [] },
            { type: 'function_call_output', call_id: 'c1', output: 'sunny' },
            { type: 'function_call_output', call_id: 'c2', output: [{ type: 'input_text', text: 'rain' }, {}] },
            { type: 'custom_tool_call', call_id: 'c3', name: 'run_shell', input: 'ls' },
            { type: 'custom_tool_call_output', call_id: 'c3', output: { files: 2 } },
            { type: 'function_call_output', call_id: 'c4' },
        ]);
        assert.deepEqual(messages[1].toolCalls, [
            { id: 'c1', name: 'get_weather', arguments: '{"city":"A"}' },
            { id: 'c2', name: 'get_weather', arguments: '{}' },
        ]);
        assert.deepEqual(messages[2], { role: 'tool', content: 'sunny', media: [], toolCallId: 'c1' });
        assert.equal(messages[3].content, 'rain');
        assert.deepEqual(messages[4].toolCalls, [{ id: 'c3', name: 'run_shell', arguments: '{"input":"ls"}' }]);
        assert.equal(messages[5].content, '{"files":2}');
        assert.equal(messages[6].content, '""');
    });

    it('does not merge a call into an assistant message that has text', () => {
        const messages = items([
            { role: 'assistant', content: 'Let me look.' },
            { type: 'function_call', call_id: 'c1', name: 'lookup', arguments: '{}' },
        ]);
        assert.equal(messages.length, 2);
        assert.deepEqual(messages[1].toolCalls.map((c) => c.id), ['c1']);
    });

    it('validates items', () => {
        invalid(() => items([{ type: 'message', role: 'tool', content: 'x' }]), { param: 'input[0].role' });
        invalid(() => items([{ type: 'function_call', name: 'x' }]), { param: 'input[0]' });
        invalid(() => items([{ type: 'function_call_output' }]), { param: 'input[0]' });
        invalid(() => items([{ type: 'computer_call' }]), { param: 'input[0]', code: 'unsupported_parameter' });
        invalid(() => items([{}]), { code: 'unsupported_parameter' });
        invalid(() => items([{ role: 'user', content: 5 }]), { param: 'input[0].content' });
        invalid(() => items([{ role: 'user', content: [{ type: 'hologram' }] }]), { code: 'unsupported_parameter' });
    });

    it('parses user attachments and restricts them to user messages', () => {
        const png = `data:image/png;base64,${Buffer.from('p').toString('base64')}`;
        const [message] = items([{
            role: 'user',
            content: [
                { type: 'input_text', text: 'see' },
                { type: 'input_image', image_url: png },
                { type: 'input_file', file_data: `data:text/plain;base64,${Buffer.from('doc').toString('base64')}`, filename: 'd.txt' },
                { type: 'input_audio', input_audio: { data: Buffer.from('a').toString('base64'), format: 'wav' } },
                { type: 'input_audio', data: Buffer.from('a').toString('base64'), format: 'mp3' },
                { type: 'input_video', video_url: 'https://example.com/v.mp4' },
                { type: 'input_video', url: 'https://example.com/w.mp4' },
            ],
        }]);
        assert.equal(message.content, 'see\n<file name="d.txt">\ndoc\n</file>\n');
        assert.deepEqual(message.media.map((m) => m.kind), ['image', 'audio', 'audio', 'video', 'video']);
        invalid(() => items([{ role: 'user', content: [{ type: 'input_image', file_id: 'file_1' }] }]), { code: 'unsupported_parameter', message: /Files API/ });
        invalid(() => items([{ role: 'assistant', content: [{ type: 'input_image', image_url: png }] }]), { message: /Only user messages/ });
    });
});
