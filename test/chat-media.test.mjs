import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { once } from 'node:events';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { createResponsesStore } from '../src/openai/responses-store.js';
import { assertProfileMessages } from '../src/openai/media.js';

it('rejects strict media before DNS, download, model lookup or backend work on both API routes', async () => {
    let dnsCalls = 0;
    let downloads = 0;
    let modelCalls = 0;
    let backendCalls = 0;
    const config = loadConfig({}, { OPENCODE_PROFILE: 'chat', ALLOW_NO_AUTH: 'true', RATE_LIMIT_PER_MINUTE: '0' });
    const created = createApp({ config, logger: silentLogger,
        backend: { mode: 'managed', isReady: () => true, version: () => '2.1.2' },
        hub: { isConnected: () => true, toolRejections: () => 0 },
        catalog: { resolve: async () => { modelCalls += 1; return { id: 'vision-free', input: ['text', 'image', 'pdf', 'video', 'audio'] }; } },
        runner: { run: async () => { backendCalls += 1; throw new Error('unexpected backend request'); } },
        store: createResponsesStore({ maxEntries: 2 }),
    });
    const server = created.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    mock.method(dns, 'lookup', async () => { dnsCalls += 1; throw new Error('unexpected DNS'); });
    mock.method(https, 'request', () => { downloads += 1; throw new Error('unexpected download'); });
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const url = 'https://attachment.example/remote.txt';
        const cases = [
            ['/v1/chat/completions', { type: 'image_url', image_url: url }],
            ['/v1/chat/completions', { type: 'file', file: { file_url: url } }],
            ['/v1/chat/completions', { type: 'input_audio', input_audio: { data: 'invalid', format: 'wav' } }],
            ['/v1/chat/completions', { type: 'video_url', video_url: url }],
            ['/v1/responses', { type: 'input_image', image_url: url }],
            ['/v1/responses', { type: 'input_file', file_url: url }],
            ['/v1/responses', { type: 'input_audio', data: 'invalid', format: 'wav' }],
            ['/v1/responses', { type: 'input_video', video_url: url }],
        ];
        for (const [route, part] of cases) {
            const message = { role: 'user', content: [part] };
            const body = { model: 'vision-free', ...(route.endsWith('responses') ? { input: [message] } : { messages: [message] }) };
            const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            assert.equal(response.status, 400);
            assert.equal((await response.json()).error.code, 'unsupported_modality');
        }
        assert.equal(dnsCalls, 0);
        assert.equal(downloads, 0);
        assert.equal(modelCalls, 0);
        assert.equal(backendCalls, 0);
        assert.throws(() => assertProfileMessages({ messages: [{ media: [{ url }] }] }, { textOnly: true }), (error) => error.code === 'unsupported_modality');
    } finally {
        mock.restoreAll();
        created.close();
        await new Promise((resolve) => server.close(resolve));
    }
});
