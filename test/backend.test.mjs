import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createBackend } from '../src/gateway.js';
import { silentLogger } from '../src/logger.js';
import { createAttachedBackend, createManagedBackend } from '../src/opencode/backend.js';
import { resolveOpencodeBinary, spawnCommand } from '../src/opencode/binary.js';
import {
    backendConfig, backendEnv, createIsolatedRoot, randomPassword, recordBackendPid, removeIsolatedRoot, sweepStaleRoots, touchIsolatedRoot,
} from '../src/opencode/isolation.js';
import { FAKE_VERSION, startFakeOpencode, waitFor } from './helpers/fake-opencode.mjs';

const FAKE_SERVE = fileURLToPath(new URL('./helpers/fake-serve.mjs', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zengate-backend-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Write an executable launcher that runs the fake server with node. */
function launcher(name, extraArgs = []) {
    const extra = extraArgs.map((arg) => ` "${arg}"`).join('');
    if (process.platform === 'win32') {
        const file = path.join(tmp, `${name}.cmd`);
        fs.writeFileSync(file, `@"${process.execPath}" "${FAKE_SERVE}"${extra} %*\r\n`);
        return file;
    }
    const file = path.join(tmp, name);
    fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SERVE}"${extra} "$@"\n`, { mode: 0o755 });
    return file;
}

const deadPid = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    child.once('exit', () => resolve(child.pid));
});

describe('attached backend', () => {
    let fake;
    before(async () => { fake = await startFakeOpencode(); });
    after(async () => { await fake.close(); });

    it('probes health on start and exposes the client', async () => {
        const backend = createAttachedBackend({ url: fake.url, username: 'opencode', password: '', logger: silentLogger });
        assert.equal(backend.mode, 'attached');
        assert.equal(backend.ownsAllSessions, false);
        assert.equal(backend.isReady(), false);
        await backend.start();
        assert.equal(backend.isReady(), true);
        assert.equal(backend.version(), FAKE_VERSION);
        assert.equal(backend.getClient().baseUrl, fake.url);
        await backend.stop();
    });

    it('refuses to start against an unhealthy or unreachable server', async () => {
        fake.state.healthy = false;
        try {
            const backend = createAttachedBackend({ url: fake.url, username: 'opencode', password: '', logger: silentLogger });
            await assert.rejects(backend.start(), /is not healthy/);
            assert.equal(backend.isReady(), false);
        } finally {
            fake.state.healthy = true;
        }
        const unreachable = createAttachedBackend({ url: 'http://127.0.0.1:1', username: 'opencode', password: '', logger: silentLogger });
        await assert.rejects(unreachable.start(), /is not healthy/);
    });
});

describe('createBackend', () => {
    it('picks attached mode when OPENCODE_SERVER_URL is set, managed otherwise', () => {
        const attached = createBackend(loadConfig({}, { OPENCODE_SERVER_URL: 'http://127.0.0.1:4096' }), silentLogger);
        assert.equal(attached.mode, 'attached');
        const managed = createBackend(loadConfig({}, {}), silentLogger);
        assert.equal(managed.mode, 'managed');
        assert.equal(managed.ownsAllSessions, true);
        assert.throws(() => managed.getClient(), /not started/);
    });
});

describe('managed backend (fake binary)', () => {
    it('starts, reports health, restarts after a crash and stops', { timeout: 20000 }, async () => {
        const backend = createManagedBackend({ opencodePath: launcher('opencode-fake'), logger: silentLogger });
        try {
            await backend.start();
            assert.equal(backend.isReady(), true);
            assert.equal(backend.version(), '7.7.7-fake');
            const firstUrl = backend.getClient().baseUrl;
            assert.match(firstUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
            assert.equal((await backend.getClient().health()).healthy, true, 'the random password is used');

            const auth = `Basic ${Buffer.from('opencode:wrong').toString('base64')}`;
            assert.equal((await fetch(`${firstUrl}/global/health`, { headers: { authorization: auth } })).status, 401);

            await fetch(`${firstUrl}/crash`).then((response) => response.text()).catch(() => {});
            await waitFor(() => !backend.isReady(), { timeoutMs: 5000 });
            await waitFor(() => backend.isReady() && backend.getClient().baseUrl !== firstUrl, { timeoutMs: 10000, intervalMs: 50 });
        } finally {
            await backend.stop();
        }
        assert.equal(backend.isReady(), false);
    });

    it('keeps retrying when a restart fails before OpenCode even starts', { timeout: 30000 }, async () => {
        const binary = launcher('opencode-flaky');
        const backend = createManagedBackend({ opencodePath: binary, logger: silentLogger });
        try {
            await backend.start();
            const firstUrl = backend.getClient().baseUrl;
            fs.renameSync(binary, `${binary}.away`);
            await fetch(`${firstUrl}/crash`).then((response) => response.text()).catch(() => {});
            await waitFor(() => !backend.isReady(), { timeoutMs: 5000 });
            // The first restart (after 1s) finds no binary; put it back before the next one.
            await new Promise((resolve) => setTimeout(resolve, 1500));
            fs.renameSync(`${binary}.away`, binary);
            await waitFor(() => backend.isReady() && backend.getClient().baseUrl !== firstUrl, { timeoutMs: 15000, intervalMs: 50 });
        } finally {
            await backend.stop();
        }
    });

    it('fails clearly when the binary exits during startup', { timeout: 20000 }, async () => {
        const backend = createManagedBackend({ opencodePath: launcher('opencode-dies', ['--exit-immediately']), logger: silentLogger });
        await assert.rejects(backend.start(), /exited during startup/);
        await backend.stop();
    });

    it('fails clearly when OPENCODE_PATH does not exist', async () => {
        const backend = createManagedBackend({ opencodePath: path.join(tmp, 'missing', 'opencode'), logger: silentLogger });
        await assert.rejects(backend.start(), /does not point to a file/);
    });
});

describe('binary resolution', () => {
    it('uses an explicit path when it is a file', () => {
        const file = path.join(tmp, 'opencode-bin');
        fs.writeFileSync(file, '');
        assert.deepEqual(resolveOpencodeBinary(file), { path: path.resolve(file), source: 'config' });
        assert.throws(() => resolveOpencodeBinary(path.join(tmp, 'nope', 'opencode')), /does not point to a file/);
    });

    it('searches PATH for a bare name and reports a miss', () => {
        assert.throws(() => resolveOpencodeBinary('definitely-not-an-opencode-binary'), /was not found on PATH/);
        const name = 'node';
        const found = resolveOpencodeBinary(name);
        assert.equal(found.source, 'config');
        assert.ok(fs.statSync(found.path).isFile());
    });

    it('falls back to the bundled package or PATH', () => {
        let resolved;
        try {
            resolved = resolveOpencodeBinary('');
        } catch (error) {
            assert.match(error.message, /OpenCode CLI not found/);
            return;
        }
        assert.ok(['bundled', 'PATH'].includes(resolved.source));
    });

    it('builds spawn arguments, quoting .cmd shims on Windows', () => {
        const plain = spawnCommand('/usr/bin/opencode', ['serve']);
        assert.deepEqual(plain, { command: '/usr/bin/opencode', args: ['serve'], windowsVerbatimArguments: false });
        const shim = spawnCommand('C:\\tools\\opencode.cmd', ['serve', '--port', '1']);
        if (process.platform === 'win32') {
            assert.equal(shim.windowsVerbatimArguments, true);
            assert.deepEqual(shim.args.slice(0, 3), ['/d', '/s', '/c']);
            assert.equal(shim.args[3], '""C:\\tools\\opencode.cmd" "serve" "--port" "1""');
            assert.throws(() => spawnCommand('C:\\100%\\opencode.cmd', []), /cannot be run safely/);
        } else {
            assert.equal(shim.windowsVerbatimArguments, false);
        }
    });
});

describe('isolation', () => {
    it('configures OpenCode to ask for every tool permission', () => {
        const config = backendConfig();
        assert.equal(config.permission['*'], 'ask');
        assert.equal(config.permission.bash, 'ask');
        assert.equal(config.autoupdate, false);
        assert.equal(config.share, 'disabled');
        assert.equal(config.experimental.continue_loop_on_deny, true);
    });

    it('creates and removes a private scratch tree', () => {
        const dirs = createIsolatedRoot();
        try {
            for (const name of ['home', 'workspace', 'data', 'config', 'cache', 'state']) assert.ok(fs.statSync(dirs[name]).isDirectory());
            assert.match(fs.readFileSync(path.join(dirs.root, 'owner.pid'), 'utf8'), new RegExp(`^${process.pid}\\n[0-9a-f]{16}\\n(pid:\\[\\d+\\])?\\n$`));
            assert.ok(path.basename(dirs.root).startsWith('zengate-'));
        } finally {
            removeIsolatedRoot(dirs.root);
        }
        assert.equal(fs.existsSync(dirs.root), false);
    });

    it('never removes directories it did not create', () => {
        const foreign = fs.mkdtempSync(path.join(tmp, 'keep-'));
        removeIsolatedRoot(foreign);
        removeIsolatedRoot(undefined);
        assert.ok(fs.existsSync(foreign));
    });

    it('sweeps scratch trees of dead gateway processes only', async () => {
        const stale = createIsolatedRoot();
        const live = createIsolatedRoot();
        try {
            fs.writeFileSync(path.join(stale.root, 'owner.pid'), String(await deadPid()));
            assert.ok(sweepStaleRoots() >= 1);
            assert.equal(fs.existsSync(stale.root), false);
            assert.ok(fs.existsSync(live.root), 'our own tree is kept');
        } finally {
            removeIsolatedRoot(stale.root);
            removeIsolatedRoot(live.root);
        }
    });

    it('sweeps trees of an earlier process that had the same pid (container restarts)', () => {
        const earlier = createIsolatedRoot();
        const legacy = createIsolatedRoot();
        try {
            fs.writeFileSync(path.join(earlier.root, 'owner.pid'), `${process.pid}\n0000000000000000\n`);
            fs.writeFileSync(path.join(legacy.root, 'owner.pid'), String(process.pid));
            assert.ok(sweepStaleRoots() >= 2);
            assert.equal(fs.existsSync(earlier.root), false);
            assert.equal(fs.existsSync(legacy.root), false);
        } finally {
            removeIsolatedRoot(earlier.root);
            removeIsolatedRoot(legacy.root);
        }
    });

    it('judges trees from another pid namespace by how recently they were touched', () => {
        const fresh = createIsolatedRoot();
        const abandoned = createIsolatedRoot();
        try {
            for (const dirs of [fresh, abandoned]) fs.writeFileSync(path.join(dirs.root, 'owner.pid'), `1\n0000000000000000\npid:[1]\n`);
            const old = new Date(Date.now() - 10 * 60 * 1000);
            fs.utimesSync(path.join(abandoned.root, 'owner.pid'), old, old);
            sweepStaleRoots();
            assert.ok(fs.existsSync(fresh.root), 'a container sharing /tmp that is still alive keeps its tree');
            assert.equal(fs.existsSync(abandoned.root), false);
            fs.utimesSync(path.join(fresh.root, 'owner.pid'), old, old);
            touchIsolatedRoot(fresh.root);
            sweepStaleRoots();
            assert.ok(fs.existsSync(fresh.root), 'touching the tree keeps it alive');
        } finally {
            removeIsolatedRoot(fresh.root);
            removeIsolatedRoot(abandoned.root);
        }
    });

    it('stops the backend a dead gateway left running', { skip: process.platform !== 'linux' }, async () => {
        const stale = createIsolatedRoot();
        const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: stale.workspace, detached: true, stdio: 'ignore' });
        const exited = new Promise((resolve) => orphan.once('exit', (code, signal) => resolve(signal)));
        try {
            recordBackendPid(stale.root, orphan.pid);
            fs.writeFileSync(path.join(stale.root, 'owner.pid'), String(await deadPid()));
            sweepStaleRoots();
            assert.equal(await exited, 'SIGKILL');
            assert.equal(fs.existsSync(stale.root), false);
        } finally {
            orphan.kill('SIGKILL');
            removeIsolatedRoot(stale.root);
        }
    });

    it('builds a minimal child environment without gateway secrets', () => {
        const previous = process.env.API_KEY;
        process.env.API_KEY = 'gateway-secret-should-not-leak';
        try {
            const dirs = { home: '/h', data: '/d', config: '/c', cache: '/k', state: '/s' };
            const env = backendEnv(dirs, 'pw');
            assert.equal(env.API_KEY, undefined);
            assert.equal(env.HOME, '/h');
            assert.equal(env.USERPROFILE, '/h');
            assert.equal(env.XDG_CONFIG_HOME, '/c');
            assert.equal(env.OPENCODE_SERVER_PASSWORD, 'pw');
            assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
            assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), backendConfig());
            if (process.env.PATH) assert.equal(env.PATH, process.env.PATH);
        } finally {
            if (previous === undefined) delete process.env.API_KEY;
            else process.env.API_KEY = previous;
        }
    });

    it('generates strong random passwords', () => {
        const a = randomPassword();
        assert.match(a, /^[\w-]{43}$/);
        assert.notEqual(a, randomPassword());
    });
});
