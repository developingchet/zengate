import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createResponsesStore } from '../src/openai/responses-store.js';
import { createApp } from '../src/server/app.js';

describe('app', () => {
    const lines = [];
    let server;
    let base;
    let drain;

    before(async () => {
        const config = loadConfig({}, { ALLOW_NO_AUTH: 'true', RATE_LIMIT_PER_MINUTE: '0' });
        const logger = createLogger({ level: 'info', json: true, sink: { out: (line) => lines.push(JSON.parse(line)), err: () => {} } });
        const backend = { mode: 'managed', isReady: () => true, version: () => '1.2.3' };
        const hub = { isConnected: () => true };
        const store = createResponsesStore({ maxEntries: 1 });
        const created = createApp({ config, logger, backend, hub, catalog: {}, runner: {}, store });
        drain = created.startDraining;
        server = created.app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => new Promise((resolve) => server.close(resolve)));

    it('writes one access-log line per API request, but none for probes', async () => {
        lines.length = 0;
        await (await fetch(`${base}/health`)).text();
        await (await fetch(`${base}/metrics?verbose=1`, { headers: { 'x-request-id': 'trace-1' } })).text();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(lines.length, 1);
        const [line] = lines;
        assert.equal(line.msg, 'GET /metrics 200');
        assert.equal(line.requestId, 'trace-1');
        assert.equal(line.client, 'anonymous');
        assert.equal(typeof line.ms, 'number');
    });

    it('reports "stopping" on /ready once draining starts', async () => {
        assert.equal((await fetch(`${base}/ready`)).status, 200);
        drain();
        const response = await fetch(`${base}/ready`);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { status: 'stopping', backend: 'managed' });
    });
});
