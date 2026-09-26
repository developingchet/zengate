import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatRequest } from '../src/openai/chat-request.js';
import { buildPrompt } from '../src/openai/prompt.js';

const TEXT_MODEL = Object.freeze({ id: 'big-pickle', providerID: 'opencode', modelID: 'big-pickle', input: ['text'], variants: ['high', 'low'] });
const VISION_MODEL = Object.freeze({ id: 'other/vision', providerID: 'other', modelID: 'vision', input: ['text', 'image'], variants: [] });
const WEATHER = { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } };
const PNG = `data:image/png;base64,${Buffer.from('png').toString('base64')}`;

const request = (body) => parseChatRequest({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }], ...body }, { maxBytes: 1 << 20 });
const build = (body, model = TEXT_MODEL) => buildPrompt(request(body), model);

describe('buildPrompt', () => {
    it('sends a single user turn verbatim', () => {
        const prompt = build({});
        assert.deepEqual(prompt.model, { providerID: 'opencode', modelID: 'big-pickle' });
        assert.deepEqual(prompt.parts, [{ type: 'text', text: 'hi' }]);
        assert.equal(prompt.system, undefined);
        assert.equal(prompt.variant, undefined);
        assert.equal(prompt.format, undefined);
        assert.deepEqual(prompt.clientTools, []);
    });

    it('joins system and developer messages into the system prompt', () => {
        const prompt = build({ messages: [{ role: 'system', content: 'A' }, { role: 'developer', content: 'B' }, { role: 'system', content: '' }, { role: 'user', content: 'hi' }] });
        assert.equal(prompt.system, 'A\n\nB');
    });

    it('renders multi-turn conversations as a transcript', () => {
        const prompt = build({
            messages: [
                { role: 'user', content: 'weather in Paris?' },
                { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
                { role: 'tool', tool_call_id: 'c1', content: 'sunny' },
                { role: 'tool', tool_call_id: 'unknown', content: 'orphan' },
                { role: 'user', content: 'thanks' },
            ],
        });
        assert.equal(prompt.parts.length, 1);
        const { text } = prompt.parts[0];
        assert.match(text, /^The conversation so far is below/);
        assert.match(text, /<user>\nweather in Paris\?\n<\/user>/);
        assert.match(text, /<assistant>\n<tool_call>\{"name":"get_weather","arguments":\{"city":"Paris"\}\}<\/tool_call>\n<\/assistant>/);
        assert.match(text, /<tool_result name="get_weather" call_id="c1">\nsunny\n<\/tool_result>/);
        assert.match(text, /<tool_result name="function" call_id="unknown">/);
        assert.ok(text.trim().endsWith('<user>\nthanks\n</user>'));
    });

    it('uses a transcript when the only turn is from the assistant', () => {
        const prompt = build({ messages: [{ role: 'assistant', content: 'hello' }] });
        assert.match(prompt.parts[0].text, /<assistant>\nhello\n<\/assistant>/);
    });

    it('requires at least one non-system turn', () => {
        assert.throws(() => build({ messages: [{ role: 'system', content: 'only' }] }), { status: 400, param: 'messages' });
    });

    it('rejects images for text-only models', () => {
        const body = { messages: [{ role: 'user', content: [{ type: 'text', text: 'what is it' }, { type: 'image_url', image_url: { url: PNG } }] }] };
        assert.throws(() => build(body), (error) => error.status === 400 && error.code === 'unsupported_modality' && /does not accept image/.test(error.message));
    });

    it('attaches images for vision models, in single and multi-turn form', () => {
        const single = build({ messages: [{ role: 'user', content: [{ type: 'text', text: 'what is it' }, { type: 'image_url', image_url: { url: PNG } }] }] }, VISION_MODEL);
        assert.deepEqual(single.parts, [
            { type: 'text', text: 'what is it' },
            { type: 'file', mime: 'image/png', url: PNG, filename: 'attachment-1' },
        ]);
        const onlyImage = build({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG } }] }] }, VISION_MODEL);
        assert.deepEqual(onlyImage.parts.map((p) => p.type), ['file']);
        const multi = build({
            messages: [
                { role: 'user', content: [{ type: 'image_url', image_url: { url: PNG } }] },
                { role: 'assistant', content: 'a cat' },
                { role: 'user', content: 'sure?' },
            ],
        }, VISION_MODEL);
        assert.match(multi.parts[0].text, /<user>\n\[attachment 1: image\]\n<\/user>/);
        assert.equal(multi.parts[1].type, 'file');
    });

    it('sends a placeholder text part for an empty message', () => {
        assert.deepEqual(build({ messages: [{ role: 'user', content: '' }] }).parts, [{ type: 'text', text: ' ' }]);
    });

    it('uses native json_schema output only without tools', () => {
        const schema = { type: 'object', properties: { a: { type: 'number' } } };
        const native = build({ response_format: { type: 'json_schema', json_schema: { name: 'x', schema } } });
        assert.deepEqual(native.format, { type: 'json_schema', schema });
        assert.equal(native.system, undefined);
        const object = build({ response_format: { type: 'json_object' } });
        assert.deepEqual(object.format, { type: 'json_schema', schema: { type: 'object' } });

        const withTools = build({ tools: [WEATHER], response_format: { type: 'json_schema', json_schema: { schema } } });
        assert.equal(withTools.format, undefined);
        assert.match(withTools.system, /# Client functions/);
        assert.match(withTools.system, /reply with only JSON matching this schema: \{"type":"object"/);
        assert.deepEqual(withTools.clientTools, ['get_weather']);
        const objectWithTools = build({ tools: [WEATHER], response_format: { type: 'json_object' } });
        assert.match(objectWithTools.system, /only a valid JSON object/);

        const toolsDisabled = build({ tools: [WEATHER], tool_choice: 'none', response_format: { type: 'json_object' } });
        assert.deepEqual(toolsDisabled.format, { type: 'json_schema', schema: { type: 'object' } });
        assert.deepEqual(toolsDisabled.clientTools, []);
        assert.equal(toolsDisabled.system, undefined);
    });

    it('maps reasoning_effort to a model variant when it exists', () => {
        assert.equal(build({ reasoning_effort: 'high' }).variant, 'high');
        assert.equal(build({ reasoning_effort: 'medium' }).variant, undefined);
        assert.equal(build({ reasoning_effort: 'none' }).variant, undefined);
    });
});
