import { execFile, spawn } from 'node:child_process';
import net from 'node:net';
import { createOpencodeClient } from './client.js';
import { resolveOpencodeBinary, spawnCommand } from './binary.js';
import { backendEnv, createIsolatedRoot, randomPassword, removeIsolatedRoot, sweepStaleRoots } from './isolation.js';

const START_TIMEOUT_MS = 60000;
const MAX_RESTART_DELAY_MS = 30000;
const ANSI = /\x1b\[[0-9;]*m/g;

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function killTree(child) {
    if (!child?.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        return;
    }
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, 3000).unref();
}

async function waitHealthy(client, deadline, isDead) {
    let lastError = null;
    while (Date.now() < deadline) {
        if (isDead()) throw new Error('OpenCode exited during startup');
        try {
            const health = await client.health();
            if (health?.healthy === true) return health;
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`OpenCode did not become healthy in ${START_TIMEOUT_MS / 1000}s${lastError ? `: ${lastError.message}` : ''}`);
}

function pipeLogs(stream, logger) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) {
            const text = line.replace(ANSI, '').trim();
            if (text) logger.debug(`[opencode] ${text}`);
        }
    });
}

/**
 * Starts and supervises a private `opencode serve` bound to 127.0.0.1 on a
 * free port with a random password. It restarts with backoff if it crashes.
 */
export function createManagedBackend({ opencodePath, logger }) {
    let client = null;
    let child = null;
    let dirs = null;
    let version = null;
    let stopping = false;
    let restartDelay = 1000;
    let ready = false;
    let everReady = false;

    async function launch() {
        const binary = resolveOpencodeBinary(opencodePath);
        dirs = createIsolatedRoot();
        const port = await freePort();
        const password = randomPassword();
        const { command, args, windowsVerbatimArguments } = spawnCommand(binary.path, ['serve', '--hostname', '127.0.0.1', '--port', String(port)]);
        logger.debug('Starting OpenCode backend', { binary: binary.path, source: binary.source, port });
        const proc = spawn(command, args, {
            cwd: dirs.workspace,
            env: backendEnv(dirs, password),
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
            windowsHide: true,
            windowsVerbatimArguments,
        });
        child = proc;
        pipeLogs(proc.stdout, logger);
        pipeLogs(proc.stderr, logger);
        let dead = false;
        proc.once('error', (error) => { dead = true; logger.error('Could not start OpenCode', { error: error.message }); });
        proc.once('exit', (code, signal) => {
            dead = true;
            ready = false;
            if (!stopping && everReady) onCrash(code, signal, dirs.root);
        });
        const candidate = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}`, username: 'opencode', password });
        const health = await waitHealthy(candidate, Date.now() + START_TIMEOUT_MS, () => dead);
        client = candidate;
        version = health.version || null;
        ready = true;
        everReady = true;
        restartDelay = 1000;
        logger.info(`OpenCode ${version || ''} backend ready (managed, isolated, tools disabled)`.replace('  ', ' '));
    }

    function onCrash(code, signal, root) {
        logger.warn(`OpenCode backend exited (${signal || code}); restarting in ${restartDelay / 1000}s`);
        removeIsolatedRoot(root);
        const delay = restartDelay;
        restartDelay = Math.min(MAX_RESTART_DELAY_MS, restartDelay * 2);
        setTimeout(() => {
            if (stopping) return;
            launch().catch((error) => {
                logger.error('OpenCode restart failed', { error: error.message });
                killTree(child);
            });
        }, delay).unref();
    }

    return Object.freeze({
        mode: 'managed',
        async start() {
            const swept = sweepStaleRoots();
            if (swept) logger.debug(`Removed ${swept} stale backend directories`);
            try {
                await launch();
            } catch (error) {
                stopping = true;
                killTree(child);
                removeIsolatedRoot(dirs?.root);
                throw error;
            }
        },
        getClient() {
            if (!client) throw new Error('OpenCode backend is not started');
            return client;
        },
        isReady: () => ready,
        version: () => version,
        ownsAllSessions: true,
        async stop() {
            stopping = true;
            ready = false;
            if (child && child.exitCode === null) {
                const exited = new Promise((resolve) => child.once('exit', resolve));
                killTree(child);
                await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000).unref())]);
            }
            removeIsolatedRoot(dirs?.root);
        },
    });
}

/** Uses an OpenCode server someone else runs (OPENCODE_SERVER_URL). */
export function createAttachedBackend({ url, username, password, logger }) {
    const client = createOpencodeClient({ baseUrl: url, username, password });
    let ready = false;
    let version = null;
    let timer = null;

    async function probe() {
        try {
            const health = await client.health();
            ready = health?.healthy === true;
            version = health?.version || version;
        } catch {
            ready = false;
        }
        return ready;
    }

    return Object.freeze({
        mode: 'attached',
        async start() {
            if (!(await probe())) throw new Error(`OpenCode server at ${url} is not healthy (GET /global/health). Check the URL and credentials.`);
            logger.info(`Using OpenCode ${version || ''} at ${url}`.replace('  ', ' '));
            logger.warn('Attached mode: the gateway rejects tool permissions for its own sessions, but the server\'s own configuration still applies. Prefer the managed backend.');
            timer = setInterval(probe, 10000);
            timer.unref();
        },
        getClient: () => client,
        isReady: () => ready,
        version: () => version,
        ownsAllSessions: false,
        async stop() {
            clearInterval(timer);
        },
    });
}
