import { EventEmitter } from 'node:events';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { listen } from '../src/gateway.js';

it('explains EACCES at the listener boundary without changing the selected port', async () => {
    const cause = Object.assign(new Error('listen EACCES'), { code: 'EACCES' });
    const app = { listen(port, host) {
        assert.equal(port, 8083);
        assert.equal(host, '127.0.0.1');
        const server = new EventEmitter();
        queueMicrotask(() => server.emit('error', cause));
        return server;
    } };
    await assert.rejects(listen(app, { PORT: 8083, HOST: '127.0.0.1' }), (error) => {
        assert.equal(error.cause, cause);
        assert.match(error.message, /port 8083 on 127.0.0.1/);
        assert.match(error.message, /excluded TCP range/);
        assert.match(error.message, /netsh.*set PORT/);
        return true;
    });
});
