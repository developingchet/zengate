import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KEY_PREFIX, generateApiKey, loadOrProvisionConfig, securityWarnings, writeConfigFile } from '../src/bootstrap.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { createLogger, silentLogger } from '../src/logger.js';

const KEY = 'test-key-0123456789abcdef';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zengate-bootstrap-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('generateApiKey / writeConfigFile', () => {
    it('generates distinct prefixed keys long enough to pass validation', () => {
        const a = generateApiKey();
        const b = generateApiKey();
        assert.ok(a.startsWith(KEY_PREFIX));
        assert.notEqual(a, b);
        assert.ok(a.length >= 16);
        assert.doesNotThrow(() => loadConfig({ API_KEY: a }, {}));
    });

    it('writes pretty JSON atomically', () => {
        const file = path.join(tmp, 'written.json');
        writeConfigFile(file, { PORT: 1 });
        assert.equal(fs.readFileSync(file, 'utf8'), '{\n    "PORT": 1\n}\n');
        assert.deepEqual(fs.readdirSync(tmp).filter((name) => name.endsWith('.tmp')), []);
        if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    });
});

describe('loadOrProvisionConfig', () => {
    it('provisions a key into config.json on first run and keeps other settings', () => {
        const dir = fs.mkdtempSync(path.join(tmp, 'first-'));
        const configPath = path.join(dir, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify({ PORT: 9100 }));
        const lines = [];
        const config = loadOrProvisionConfig({ configPath, env: {}, logger: silentLogger, print: (line) => lines.push(line) });
        assert.equal(config.PORT, 9100);
        assert.equal(config.API_KEYS.length, 1);
        const [key] = config.API_KEYS;
        assert.ok(key.startsWith(KEY_PREFIX));
        const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.deepEqual(saved, { PORT: 9100, API_KEY: key });
        assert.ok(lines.some((line) => line.includes(key)), 'the new key is printed once');
    });

    it('creates config.json when it does not exist', () => {
        const configPath = path.join(fs.mkdtempSync(path.join(tmp, 'fresh-')), 'config.json');
        const config = loadOrProvisionConfig({ configPath, env: {}, logger: silentLogger, print: () => {} });
        assert.ok(fs.existsSync(configPath));
        assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).API_KEY, config.API_KEYS[0]);
    });

    it('does not touch the file when a key is already configured', () => {
        const configPath = path.join(fs.mkdtempSync(path.join(tmp, 'keyed-')), 'config.json');
        const config = loadOrProvisionConfig({ configPath, env: { API_KEY: KEY }, logger: silentLogger, print: () => assert.fail('no output') });
        assert.deepEqual(config.API_KEYS, [KEY]);
        assert.equal(fs.existsSync(configPath), false);
    });

    it('does not provision when auth is explicitly disabled', () => {
        const configPath = path.join(fs.mkdtempSync(path.join(tmp, 'noauth-')), 'config.json');
        const config = loadOrProvisionConfig({ configPath, env: { ALLOW_NO_AUTH: 'true' }, logger: silentLogger, print: () => {} });
        assert.deepEqual(config.API_KEYS, []);
        assert.equal(fs.existsSync(configPath), false);
    });

    it('raises a ConfigError when config.json cannot be written', () => {
        const configPath = path.join(tmp, 'no-such-dir', 'nested', 'config.json');
        assert.throws(
            () => loadOrProvisionConfig({ configPath, env: {}, logger: silentLogger, print: () => {} }),
            (error) => error instanceof ConfigError && /could not be written/.test(error.message) && /ALLOW_NO_AUTH/.test(error.message),
        );
    });
});

describe('securityWarnings', () => {
    const base = loadConfig({ API_KEY: KEY }, {});

    it('is quiet for a keyed loopback gateway', () => {
        assert.deepEqual(securityWarnings(base), []);
    });

    it('warns about disabled auth, louder when exposed', () => {
        const local = securityWarnings({ ...base, ALLOW_NO_AUTH: true });
        assert.equal(local.length, 1);
        assert.match(local[0], /any local process/);
        const exposed = securityWarnings({ ...base, ALLOW_NO_AUTH: true, HOST: '0.0.0.0' });
        assert.equal(exposed.length, 1);
        assert.match(exposed[0], /anyone who can reach this port/);
    });

    it('recommends TLS when listening beyond loopback', () => {
        const warnings = securityWarnings({ ...base, HOST: '0.0.0.0' });
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /TLS/);
    });
});

describe('logger', () => {
    const capture = (options) => {
        const out = [];
        const err = [];
        const logger = createLogger({ ...options, sink: { out: (line) => out.push(line), err: (line) => err.push(line) } });
        return { logger, out, err };
    };

    it('filters by level and routes warnings to stderr', () => {
        const { logger, out, err } = capture({ level: 'info' });
        logger.debug('hidden');
        logger.info('hello', { a: 1 });
        logger.warn('careful');
        logger.error('broken', {});
        assert.deepEqual(out, ['hello {"a":1}']);
        assert.deepEqual(err, ['[warn] careful', '[error] broken']);
        assert.equal(logger.isDebug, false);
        assert.ok(Object.isFrozen(logger));
    });

    it('writes JSON lines when asked', () => {
        const { logger, out } = capture({ level: 'debug', json: true });
        logger.debug('dbg', { requestId: 'r1' });
        const line = JSON.parse(out[0]);
        assert.equal(line.level, 'debug');
        assert.equal(line.msg, 'dbg');
        assert.equal(line.requestId, 'r1');
        assert.ok(!Number.isNaN(Date.parse(line.ts)));
        assert.equal(logger.isDebug, true);
    });

    it('falls back to info for an unknown level', () => {
        const { logger, out } = capture({ level: 'nope' });
        logger.debug('hidden');
        logger.info('shown');
        assert.deepEqual(out, ['shown']);
    });

    it('silentLogger discards everything', () => {
        assert.doesNotThrow(() => {
            silentLogger.debug('x');
            silentLogger.info('x');
            silentLogger.warn('x');
            silentLogger.error('x');
        });
    });
});
