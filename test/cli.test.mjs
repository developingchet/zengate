import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KEY_PREFIX } from '../src/bootstrap.js';
import { parseCommand, runSetup } from '../src/cli.js';
import { defaultConfigPath, isInstalledPackage } from '../src/paths.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zengate-cli-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function capture() {
    const lines = [];
    return { lines, out: (line = '') => lines.push(line) };
}

describe('defaultConfigPath', () => {
    const checkout = path.join('/srv', 'zengate');
    const installed = path.join('/usr', 'lib', 'node_modules', 'zengate');

    it('prefers CONFIG_FILE', () => {
        assert.equal(defaultConfigPath({ root: installed, env: { CONFIG_FILE: '/data/c.json' }, platform: 'linux', homedir: '/home/u' }), '/data/c.json');
    });

    it('keeps config.json next to the code in a source checkout', () => {
        assert.equal(defaultConfigPath({ root: checkout, env: {}, platform: 'linux', homedir: '/home/u' }), path.join(checkout, 'config.json'));
    });

    it('uses the per-user config directory when installed from npm', () => {
        assert.ok(isInstalledPackage(installed));
        assert.ok(!isInstalledPackage(checkout));
        assert.equal(defaultConfigPath({ root: installed, env: {}, platform: 'linux', homedir: '/home/u' }), path.join('/home/u', '.config', 'zengate', 'config.json'));
        assert.equal(defaultConfigPath({ root: installed, env: { XDG_CONFIG_HOME: '/x' }, platform: 'linux', homedir: '/home/u' }), path.join('/x', 'zengate', 'config.json'));
        assert.equal(defaultConfigPath({ root: installed, env: {}, platform: 'darwin', homedir: '/Users/u' }), path.join('/Users/u', 'Library', 'Application Support', 'zengate', 'config.json'));
        assert.equal(defaultConfigPath({ root: installed, env: { APPDATA: 'C:\\AppData' }, platform: 'win32', homedir: 'C:\\u' }), path.join('C:\\AppData', 'zengate', 'config.json'));
        assert.equal(defaultConfigPath({ root: installed, env: {}, platform: 'win32', homedir: 'C:\\u' }), path.join('C:\\u', 'AppData', 'Roaming', 'zengate', 'config.json'));
    });

    it('ignores relative XDG_CONFIG_HOME, as the spec requires', () => {
        assert.equal(defaultConfigPath({ root: installed, env: { XDG_CONFIG_HOME: 'rel' }, platform: 'linux', homedir: '/home/u' }), path.join('/home/u', '.config', 'zengate', 'config.json'));
    });
});

describe('parseCommand', () => {
    it('starts the server by default', () => {
        assert.deepEqual(parseCommand([]), { command: 'serve', flags: [] });
    });

    it('recognises help, version and setup', () => {
        assert.equal(parseCommand(['--help']).command, 'help');
        assert.equal(parseCommand(['-h']).command, 'help');
        assert.equal(parseCommand(['help']).command, 'help');
        assert.equal(parseCommand(['--version']).command, 'version');
        assert.equal(parseCommand(['-v']).command, 'version');
        assert.deepEqual(parseCommand(['setup', '--rotate']), { command: 'setup', flags: ['--rotate'] });
        assert.deepEqual(parseCommand(['setup', '--show']), { command: 'setup', flags: ['--show'] });
    });

    it('rejects unknown commands and flags', () => {
        assert.equal(parseCommand(['serve-me']).command, 'unknown');
        assert.equal(parseCommand(['setup', '--nope']).command, 'unknown');
    });
});

describe('runSetup', () => {
    it('creates a key (and the parent directory) when none exists', () => {
        const file = path.join(tmp, 'nested', 'dir', 'config.json');
        const { lines, out } = capture();
        assert.equal(runSetup({ configPath: file, flags: [], out }), 0);
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.ok(saved.API_KEY.startsWith(KEY_PREFIX));
        assert.ok(lines.some((line) => line.includes(saved.API_KEY)));
    });

    it('keeps an existing key unless --rotate is given, and preserves other settings', () => {
        const file = path.join(tmp, 'keep.json');
        fs.writeFileSync(file, JSON.stringify({ API_KEY: 'existing-key-0123456789', PORT: 9000 }));
        const first = capture();
        assert.equal(runSetup({ configPath: file, flags: [], out: first.out }), 0);
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).API_KEY, 'existing-key-0123456789');
        assert.match(first.lines.join('\n'), /already has an API_KEY/);

        assert.equal(runSetup({ configPath: file, flags: ['--rotate'], out: () => {} }), 0);
        const rotated = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.notEqual(rotated.API_KEY, 'existing-key-0123456789');
        assert.equal(rotated.PORT, 9000);
    });

    it('--print only prints a key and writes nothing', () => {
        const file = path.join(tmp, 'print.json');
        const { lines, out } = capture();
        assert.equal(runSetup({ configPath: file, flags: ['--print'], out }), 0);
        assert.equal(lines.length, 1);
        assert.ok(lines[0].startsWith(KEY_PREFIX));
        assert.ok(!fs.existsSync(file));
    });

    it('--show prints the saved key and changes nothing', () => {
        const file = path.join(tmp, 'show.json');
        const content = JSON.stringify({ API_KEY: 'saved-key-0123456789', PORT: 9000 });
        fs.writeFileSync(file, content);
        const { lines, out } = capture();
        assert.equal(runSetup({ configPath: file, flags: ['--show'], out }), 0);
        assert.deepEqual(lines, ['saved-key-0123456789']);
        assert.equal(fs.readFileSync(file, 'utf8'), content);
    });

    it('--show fails without a saved key and refuses other flags', () => {
        const missing = path.join(tmp, 'show-missing.json');
        assert.throws(() => runSetup({ configPath: missing, flags: ['--show'], out: () => assert.fail('no output') }), /has no API_KEY/);
        assert.ok(!fs.existsSync(missing));
        const file = path.join(tmp, 'show-combined.json');
        fs.writeFileSync(file, JSON.stringify({ API_KEY: 'saved-key-0123456789' }));
        for (const other of ['--rotate', '--print']) {
            assert.throws(() => runSetup({ configPath: file, flags: ['--show', other], out: () => assert.fail('no output') }), /cannot be combined/);
        }
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).API_KEY, 'saved-key-0123456789');
    });
});
