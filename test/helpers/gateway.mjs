import { loadConfig } from '../../src/config.js';
import { startGateway } from '../../src/gateway.js';
import { silentLogger } from '../../src/logger.js';
import { createAttachedBackend } from '../../src/opencode/backend.js';
import { startFakeOpencode } from './fake-opencode.mjs';

export const KEY = 'test-key-0123456789abcdef';
export const OTHER_KEY = 'other-key-0123456789abcdef';

/**
 * Start a fake OpenCode server and a real gateway attached to it.
 * `overrides` are applied on top of the validated config, which allows
 * test-only values below the normal minimums (PORT 0, short timeouts).
 */
export async function startStack({ env = {}, overrides = {}, fake: fakeOptions } = {}) {
    const fake = await startFakeOpencode(fakeOptions);
    const config = {
        ...loadConfig({}, { API_KEYS: `${KEY},${OTHER_KEY}`, RATE_LIMIT_PER_MINUTE: '0', ...env }),
        PORT: 0,
        ...overrides,
    };
    const backend = createAttachedBackend({ url: fake.url, username: 'opencode', password: '', logger: silentLogger });
    const gateway = await startGateway(config, { logger: silentLogger, backend });
    const base = `http://127.0.0.1:${gateway.address.port}`;

    const request = (path, { key = KEY, body, headers = {}, ...init } = {}) => fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        ...init,
        headers: {
            ...(key ? { authorization: `Bearer ${key}` } : {}),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...headers,
        },
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });

    return {
        fake,
        gateway,
        config,
        base,
        request,
        async json(path, init) {
            const response = await request(path, init);
            return { status: response.status, headers: response.headers, body: await response.json() };
        },
        async stop() {
            await gateway.stop();
            await fake.close();
        },
    };
}

/** Parse an SSE response body into { event, data } objects ([DONE] kept as a string). */
export async function readSse(response) {
    const text = await response.text();
    return text.split(/\n\n/).filter((frame) => frame.trim() && !frame.startsWith(':')).map((frame) => {
        const lines = frame.split('\n');
        const event = lines.find((line) => line.startsWith('event: '))?.slice(7) || null;
        const data = lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
        return { event, data: data === '[DONE]' ? data : JSON.parse(data) };
    });
}
