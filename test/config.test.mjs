import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    CONFIG_KEYS, ConfigError, describeConfig, isLoopbackHost, loadConfig, needsApiKey, parseBool, readConfigFile,
} from '../src/config.js';

const KEY = 'test-key-0123456789abcdef';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zengate-config-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function problemsOf(fn) {
    try {
        fn();
    } catch (error) {
        assert.ok(error instanceof ConfigError, `expected ConfigError, got ${error}`);
        return error.problems;
    }
    assert.fail('expected a ConfigError');
    return [];
}

describe('loadConfig', () => {
    it('applies defaults and freezes the result', () => {
        const config = loadConfig({}, {});
        assert.equal(config.PORT, 8083);
        assert.equal(config.HOST, '127.0.0.1');
        assert.equal(config.OPENCODE_AGENT, 'plan');
        assert.equal(config.MAX_CONCURRENT, 8);
        assert.equal(config.REQUEST_TIMEOUT_MS, 300000);
        assert.equal(config.LOG_LEVEL, 'info');
        assert.equal(config.TRUST_PROXY, 0);
        assert.deepEqual(config.API_KEYS, []);
        assert.deepEqual(config.CORS_ORIGINS, []);
        assert.equal(config.OPENCODE_SERVER_URL, '');
        assert.equal('API_KEY' in config, false);
        assert.ok(Object.isFrozen(config));
        assert.ok(CONFIG_KEYS.includes('PORT'));
    });

    it('lets the environment override config.json', () => {
        const config = loadConfig({ PORT: 9000, HOST: '0.0.0.0', API_KEY: KEY }, { PORT: '9001' });
        assert.equal(config.PORT, 9001);
        assert.equal(config.HOST, '0.0.0.0');
    });

    it('ignores empty environment values and falls back to the file', () => {
        const config = loadConfig({ PORT: 9000 }, { PORT: '' });
        assert.equal(config.PORT, 9000);
    });

    it('rejects unknown config.json keys but tolerates $schema', () => {
        const problems = problemsOf(() => loadConfig({ FOO: 1, BAR: 2 }, {}));
        assert.match(problems[0], /unknown config.json keys: FOO, BAR/);
        assert.doesNotThrow(() => loadConfig({ $schema: './schema.json' }, {}));
    });

    it('merges API_KEY into API_KEYS without duplicates', () => {
        const other = 'another-key-abcdefghijk';
        const config = loadConfig({ API_KEY: KEY, API_KEYS: [other, KEY] }, {});
        assert.deepEqual(config.API_KEYS, [KEY, other]);
        const fromEnv = loadConfig({}, { API_KEYS: ` ${KEY} , ${other},,` });
        assert.deepEqual(fromEnv.API_KEYS, [KEY, other]);
    });

    it('rejects short and placeholder keys', () => {
        assert.match(problemsOf(() => loadConfig({ API_KEY: 'short' }, {}))[0], /at least 16 characters/);
        assert.match(problemsOf(() => loadConfig({ API_KEY: 'Change-Me' }, {}))[0], /placeholder/);
        assert.match(problemsOf(() => loadConfig({}, { API_KEYS: 'your-secret-api-key' }))[0], /placeholder/);
    });

    it('rejects a wildcard CORS origin and accepts explicit origins', () => {
        assert.match(problemsOf(() => loadConfig({ CORS_ORIGINS: '*' }, {}))[0], /CORS_ORIGINS/);
        const config = loadConfig({ CORS_ORIGINS: 'https://a.example, https://b.example' }, {});
        assert.deepEqual(config.CORS_ORIGINS, ['https://a.example', 'https://b.example']);
    });

    it('requires https for a remote backend unless explicitly allowed', () => {
        assert.match(problemsOf(() => loadConfig({ OPENCODE_SERVER_URL: 'http://10.0.0.5:4096' }, {}))[0], /must use https/);
        const allowed = loadConfig({ OPENCODE_SERVER_URL: 'http://10.0.0.5:4096/', ALLOW_INSECURE_BACKEND_HTTP: 'true' }, {});
        assert.equal(allowed.OPENCODE_SERVER_URL, 'http://10.0.0.5:4096');
        assert.equal(loadConfig({ OPENCODE_SERVER_URL: 'https://remote.example//' }, {}).OPENCODE_SERVER_URL, 'https://remote.example');
    });

    it('allows plain http for loopback backends', () => {
        for (const url of ['http://127.0.0.1:4096', 'http://localhost:4096', 'http://[::1]:4096']) {
            assert.equal(loadConfig({ OPENCODE_SERVER_URL: url }, {}).OPENCODE_SERVER_URL, url);
        }
    });

    it('rejects malformed and non-http backend URLs', () => {
        assert.match(problemsOf(() => loadConfig({ OPENCODE_SERVER_URL: 'not a url' }, {}))[0], /absolute http/);
        assert.match(problemsOf(() => loadConfig({ OPENCODE_SERVER_URL: 'ftp://127.0.0.1' }, {}))[0], /http or https/);
    });

    it('parses TRUST_PROXY as booleans or hop counts', () => {
        assert.equal(loadConfig({}, { TRUST_PROXY: 'true' }).TRUST_PROXY, 1);
        assert.equal(loadConfig({}, { TRUST_PROXY: 'false' }).TRUST_PROXY, 0);
        assert.equal(loadConfig({}, { TRUST_PROXY: '3' }).TRUST_PROXY, 3);
        assert.equal(loadConfig({ TRUST_PROXY: true }, {}).TRUST_PROXY, 1);
        assert.match(problemsOf(() => loadConfig({}, { TRUST_PROXY: '11' }))[0], /between 0 and 10/);
    });

    it('validates integers, booleans, enums and the agent name', () => {
        assert.match(problemsOf(() => loadConfig({}, { PORT: 'abc' }))[0], /PORT must be an integer/);
        assert.match(problemsOf(() => loadConfig({}, { MAX_CONCURRENT: '0' }))[0], /between 1 and 64/);
        assert.match(problemsOf(() => loadConfig({}, { LOG_JSON: 'maybe' }))[0], /true or false/);
        assert.match(problemsOf(() => loadConfig({}, { LOG_LEVEL: 'verbose' }))[0], /one of: debug/);
        assert.match(problemsOf(() => loadConfig({}, { OPENCODE_AGENT: 'bad agent' }))[0], /simple agent name/);
        assert.equal(loadConfig({}, { LOG_LEVEL: 'DEBUG' }).LOG_LEVEL, 'debug');
        assert.equal(loadConfig({ LOG_JSON: 1 }, {}).LOG_JSON, true);
        assert.equal(loadConfig({}, { PORT: ' 1234 ' }).PORT, 1234);
    });

    it('collects every problem into one error message', () => {
        const problems = problemsOf(() => loadConfig({ NOPE: 1 }, { PORT: 'x', LOG_LEVEL: 'y' }));
        assert.equal(problems.length, 3);
        assert.throws(() => loadConfig({ NOPE: 1 }, {}), { name: 'ConfigError', message: /^Invalid configuration:\n {2}- / });
    });
});

describe('parseBool', () => {
    it('understands the usual spellings', () => {
        for (const value of [true, 1, '1', 'true', 'YES', ' on ']) assert.equal(parseBool(value), true);
        for (const value of [false, 0, '0', 'false', 'no', 'off']) assert.equal(parseBool(value), false);
        for (const value of ['maybe', 2, null, undefined, {}]) assert.equal(parseBool(value), undefined);
    });
});

describe('readConfigFile', () => {
    it('returns an empty object when the file is missing or unset', () => {
        assert.deepEqual(readConfigFile(''), {});
        assert.deepEqual(readConfigFile(path.join(tmp, 'missing.json')), {});
    });

    it('parses a JSON object', () => {
        const file = path.join(tmp, 'ok.json');
        fs.writeFileSync(file, JSON.stringify({ PORT: 1234 }));
        assert.deepEqual(readConfigFile(file), { PORT: 1234 });
    });

    it('treats malformed JSON and non-objects as ConfigError', () => {
        const bad = path.join(tmp, 'bad.json');
        fs.writeFileSync(bad, '{ not json');
        assert.throws(() => readConfigFile(bad), (error) => error instanceof ConfigError && /not valid JSON/.test(error.message));
        const array = path.join(tmp, 'array.json');
        fs.writeFileSync(array, '[1, 2]');
        assert.throws(() => readConfigFile(array), (error) => error instanceof ConfigError && /JSON object/.test(error.message));
    });
});

describe('needsApiKey / isLoopbackHost / describeConfig', () => {
    it('needs a key unless one is configured or auth is explicitly off', () => {
        assert.equal(needsApiKey(loadConfig({}, {})), true);
        assert.equal(needsApiKey(loadConfig({ API_KEY: KEY }, {})), false);
        assert.equal(needsApiKey(loadConfig({}, { ALLOW_NO_AUTH: 'true' })), false);
    });

    it('recognizes loopback hosts', () => {
        for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', ' LOCALHOST ']) assert.equal(isLoopbackHost(host), true, host);
        for (const host of ['0.0.0.0', '10.0.0.1', 'example.com', '', undefined, '128.0.0.1']) assert.equal(isLoopbackHost(host), false, String(host));
    });

    it('hides secrets', () => {
        const config = loadConfig({ API_KEY: KEY, OPENCODE_SERVER_PASSWORD: 'hunter2-secret' }, {});
        const described = describeConfig(config);
        assert.equal(described.API_KEYS, '1 configured');
        assert.equal(described.OPENCODE_SERVER_PASSWORD, 'set');
        assert.equal('API_KEY' in described, false);
        assert.equal(described.PORT, 8083);
        assert.equal(JSON.stringify(described).includes(KEY), false);
        assert.equal(JSON.stringify(described).includes('hunter2'), false);
        assert.equal(describeConfig(loadConfig({}, {})).OPENCODE_SERVER_PASSWORD, 'unset');
    });
});
