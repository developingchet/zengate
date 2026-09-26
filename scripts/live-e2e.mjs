#!/usr/bin/env node
// Live end-to-end check against a running gateway (real OpenCode, real models).
//   GATEWAY_URL=http://127.0.0.1:8083/v1 API_KEY=sk-... npm run test:live
// Optional: MODEL=big-pickle, ONLY=chat,stream (comma-separated check names).
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

const BASE = (process.env.GATEWAY_URL || 'http://127.0.0.1:8083/v1').replace(/\/+$/, '');
const KEY = process.env.API_KEY || '';
const MODEL = process.env.MODEL || 'big-pickle';
const ONLY = new Set((process.env.ONLY || '').split(',').filter(Boolean));
const out = (line) => process.stdout.write(`${line}\n`);

/** A solid red 32x32 PNG as a data URI, built so the fixture is always valid. */
function redPng() {
    const size = 32;
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (buf) => {
        let c = 0xffffffff;
        for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type), data]);
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
        return Buffer.concat([len, body, sum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([255, 0, 0]))]);
    const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
    return `data:image/png;base64,${png.toString('base64')}`;
}
const RED_PNG = redPng();

async function call(path, body, { key = KEY, method = body ? 'POST' : 'GET' } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* SSE or empty */ }
    return { status: res.status, headers: res.headers, text, json };
}

function sseEvents(text) {
    return text.split('\n\n').map((frame) => {
        const event = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        return data ? { event, data } : null;
    }).filter(Boolean);
}

const WEATHER_TOOL = {
    type: 'function',
    function: { name: 'get_weather', description: 'Current weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
};

const checks = {
    async auth() {
        const res = await call('/models', null, { key: 'sk-wrong-key-wrong-key' });
        assert.equal(res.status, 401);
        assert.equal(res.json.error.code, 'invalid_api_key');
    },
    async models() {
        const res = await call('/models');
        assert.equal(res.status, 200);
        assert.ok(res.json.data.some((m) => m.id === MODEL), `${MODEL} listed`);
        const one = await call(`/models/${MODEL}`);
        assert.equal(one.json.id, MODEL);
    },
    async chat() {
        const res = await call('/chat/completions', {
            model: MODEL,
            messages: [{ role: 'developer', content: 'Reply with one word only.' }, { role: 'user', content: 'What is the capital of France?' }],
        });
        assert.equal(res.status, 200, res.text);
        assert.match(res.json.choices[0].message.content, /paris/i);
        assert.equal(res.json.choices[0].finish_reason, 'stop');
        assert.ok(res.json.usage.total_tokens > 0);
    },
    async stream() {
        const res = await call('/chat/completions', {
            model: MODEL, stream: true, stream_options: { include_usage: true },
            messages: [{ role: 'user', content: 'Count from 1 to 5 as digits separated by spaces. Nothing else.' }],
        });
        const events = sseEvents(res.text);
        assert.equal(events.at(-1).data, '[DONE]');
        const chunks = events.slice(0, -1).map((e) => JSON.parse(e.data));
        const text = chunks.map((c) => c.choices[0]?.delta?.content || '').join('');
        assert.match(text, /1\s+2\s+3\s+4\s+5/);
        assert.ok(chunks.at(-1).usage?.total_tokens > 0, 'usage chunk');
    },
    async tools() {
        const res = await call('/chat/completions', {
            model: MODEL, tools: [WEATHER_TOOL], tool_choice: 'required',
            messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
        });
        const call0 = res.json.choices[0].message.tool_calls?.[0];
        assert.equal(res.json.choices[0].finish_reason, 'tool_calls', res.text);
        assert.equal(call0.function.name, 'get_weather');
        assert.match(JSON.parse(call0.function.arguments).city, /tokyo/i);
        const followUp = await call('/chat/completions', {
            model: MODEL, tools: [WEATHER_TOOL],
            messages: [
                { role: 'user', content: 'What is the weather in Tokyo?' },
                res.json.choices[0].message,
                { role: 'tool', tool_call_id: call0.id, content: '{"temp_c":21,"sky":"clear"}' },
            ],
        });
        assert.match(followUp.json.choices[0].message.content, /21/);
    },
    async jsonSchema() {
        const res = await call('/chat/completions', {
            model: MODEL,
            response_format: { type: 'json_schema', json_schema: { name: 'city', schema: { type: 'object', properties: { city: { type: 'string' }, country: { type: 'string' } }, required: ['city', 'country'] } } },
            messages: [{ role: 'user', content: 'Give the capital of Japan.' }],
        });
        const parsed = JSON.parse(res.json.choices[0].message.content);
        assert.match(parsed.city, /tokyo/i);
    },
    async vision() {
        const res = await call('/chat/completions', {
            model: MODEL,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'What colour is this image? One word.' }, { type: 'image_url', image_url: { url: RED_PNG } }] }],
        });
        if (res.status === 400) return 'skipped (model has no image input)';
        assert.match(res.json.choices[0].message.content, /red/i, res.text);
        return undefined;
    },
    async responses() {
        const first = await call('/responses', { model: MODEL, instructions: 'Be brief.', input: 'My name is Ada. Say hi.' });
        assert.equal(first.json.status, 'completed', first.text);
        assert.ok(first.json.output.some((item) => item.type === 'message'));
        const second = await call('/responses', { model: MODEL, previous_response_id: first.json.id, input: 'What is my name? One word.' });
        assert.match(second.json.output.find((i) => i.type === 'message').content[0].text, /ada/i);
        assert.equal((await call(`/responses/${first.json.id}`)).json.id, first.json.id);
    },
    async responsesStream() {
        const res = await call('/responses', { model: MODEL, stream: true, input: 'Say the word "banana".' });
        const events = sseEvents(res.text).map((e) => ({ type: e.event, ...JSON.parse(e.data) }));
        assert.equal(events[0].type, 'response.created');
        assert.equal(events.at(-1).type, 'response.completed');
        assert.ok(events.every((e, i) => e.sequence_number === i), 'sequence numbers');
        const text = events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('');
        assert.match(text, /banana/i);
    },
    async responsesTools() {
        const res = await call('/responses', {
            model: MODEL, tool_choice: 'required', input: 'Weather in Paris?',
            tools: [{ type: 'function', ...WEATHER_TOOL.function }],
        });
        const fc = res.json.output.find((i) => i.type === 'function_call');
        assert.equal(fc?.name, 'get_weather', res.text);
    },
    async errors() {
        const missing = await call('/chat/completions', { model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(missing.status, 404);
        assert.equal(missing.json.error.code, 'model_not_found');
        const bad = await call('/chat/completions', { model: MODEL });
        assert.equal(bad.status, 400);
        assert.equal(bad.json.error.type, 'invalid_request_error');
    },
};

let failed = 0;
for (const [name, check] of Object.entries(checks)) {
    if (ONLY.size && !ONLY.has(name)) continue;
    const started = Date.now();
    try {
        const note = await check();
        out(`ok   ${name} (${Date.now() - started} ms)${note ? ` - ${note}` : ''}`);
    } catch (error) {
        failed += 1;
        out(`FAIL ${name}: ${error.message}`);
    }
}
out(failed ? `${failed} check(s) failed` : 'all live checks passed');
process.exitCode = failed ? 1 : 0;
