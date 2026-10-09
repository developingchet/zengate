import { execFile, spawn } from 'node:child_process';
import { backendOrigin, createOpencodeClient } from './client.js';
import { resolveOpencodeBinary, spawnCommand } from './binary.js';
import {
    backendEnv, createIsolatedRoot, HEARTBEAT_MS, randomPassword, recordBackendPid, removeIsolatedRoot, sweepStaleRoots, touchIsolatedRoot,
} from './isolation.js';

const START_TIMEOUT_MS = 60000;
// Sweeping now and then (not only at start) also clears trees that were
// still too fresh to judge when this gateway started.
const SWEEP_EVERY_BEATS = 10;
const MAX_RESTART_DELAY_MS = 30000;
const ANSI = /\x1b\[[0-9;]*m/g;

const LISTENING = /listening on http:\/\/127\.0\.0\.1:(\d{1,5})\b/;

/**
 * The port OpenCode reports once it has bound it. OpenCode picks the port
 * itself (--port 0), so no other process can take it between being chosen
 * and being bound and then pose as the backend.
 */
function boundPort(proc, timeoutMs) {
    return new Promise((resolve, reject) => {
        let seen = '';
        const onData = (chunk) => {
            seen = `${seen}${chunk}`.slice(-4096);
            const port = Number(LISTENING.exec(seen.replace(ANSI, ''))?.[1]);
            if (port > 0 && port < 65536) finish(null, port);
        };
        const onExit = () => finish(new Error('OpenCode exited during startup'));
        const timer = setTimeout(() => finish(new Error(`OpenCode did not start listening in ${timeoutMs / 1000}s`)), timeoutMs);
        function finish(error, port) {
            clearTimeout(timer);
            proc.stdout.off('data', onData);
            proc.off('exit', onExit);
            proc.off('error', onExit);
            if (error) reject(error);
            else resolve(port);
        }
        proc.stdout.on('data', onData);
        proc.once('exit', onExit);
        proc.once('error', onExit);
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
 * port it picks itself, with a random password. It restarts with backoff if it crashes.
 */
export function createManagedBackend({ opencodePath, logger }) {
    let client = null;
    let child = null;
    let dirs = null;
    let version = null;
    let stopping = false;
    let restartDelay = 1000;
    let ready = false;
    let heartbeat = null;

    async function launch() {
        const binary = resolveOpencodeBinary(opencodePath);
        dirs = createIsolatedRoot();
        const { root } = dirs;
        const deadline = Date.now() + START_TIMEOUT_MS;
        const password = randomPassword();
        const { command, args, windowsVerbatimArguments } = spawnCommand(binary.path, ['serve', '--hostname', '127.0.0.1', '--port', '0']);
        logger.debug('Starting OpenCode backend', { binary: binary.path, source: binary.source });
        const proc = spawn(command, args, {
            cwd: dirs.workspace,
            env: backendEnv(dirs, password),
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
            windowsHide: true,
            windowsVerbatimArguments,
        });
        child = proc;
        if (proc.pid) recordBackendPid(root, proc.pid);
        pipeLogs(proc.stdout, logger);
        pipeLogs(proc.stderr, logger);
        let dead = false;
        let served = false;
        proc.once('error', (error) => { dead = true; logger.error('Could not start OpenCode', { error: error.message }); });
        proc.once('exit', (code, signal) => {
            dead = true;
            if (child === proc) ready = false;
            // A backend that dies while starting is handled by whoever is
            // waiting for launch(); only a crash after it served is restarted here.
            if (!stopping && served) onCrash(signal || code, root);
        });
        const port = await boundPort(proc, START_TIMEOUT_MS);
        const candidate = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}`, username: 'opencode', password });
        const health = await waitHealthy(candidate, deadline, () => dead);
        client = candidate;
        version = health.version || null;
        ready = true;
        served = true;
        restartDelay = 1000;
        logger.info(`OpenCode ${version || ''} backend ready (managed, isolated, tools disabled)`.replace('  ', ' '));
    }

    /** Kill the current backend, if any, and wait (briefly) until it is gone. */
    async function terminate() {
        const proc = child;
        if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return;
        const exited = new Promise((resolve) => proc.once('exit', resolve));
        killTree(proc);
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000).unref())]);
    }

    /** Relaunch with exponential backoff until a backend is up or the gateway stops. */
    async function restart(reason) {
        let why = reason;
        while (!stopping) {
            const delay = restartDelay;
            restartDelay = Math.min(MAX_RESTART_DELAY_MS, restartDelay * 2);
            await new Promise((resolve) => setTimeout(resolve, delay).unref());
            if (stopping) return;
            logger.warn(`OpenCode backend ${why}; restarting after ${delay / 1000}s`);
            try {
                await launch();
                return;
            } catch (error) {
                if (stopping) {
                    removeIsolatedRoot(dirs?.root);
                    return;
                }
                logger.error('OpenCode restart failed', { error: error.message });
                await terminate();
                removeIsolatedRoot(dirs?.root);
                why = 'failed to restart';
            }
        }
    }

    function onCrash(reason, root) {
        // Ctrl+C and service managers signal the whole process group, so OpenCode
        // can exit just before the gateway starts stopping. Only warn if the
        // restart actually goes ahead.
        logger.debug(`OpenCode backend exited (${reason})`);
        removeIsolatedRoot(root);
        void restart(`exited (${reason})`);
    }

    return Object.freeze({
        mode: 'managed',
        async start() {
            const sweep = async () => {
                const swept = await sweepStaleRoots();
                if (swept) logger.debug(`Removed ${swept} stale backend directories`);
            };
            await sweep();
            let beats = 0;
            heartbeat = setInterval(() => {
                if (dirs) touchIsolatedRoot(dirs.root);
                beats += 1;
                if (beats % SWEEP_EVERY_BEATS === 0) void sweep();
            }, HEARTBEAT_MS);
            heartbeat.unref();
            try {
                await launch();
            } catch (error) {
                stopping = true;
                clearInterval(heartbeat);
                await terminate();
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
            clearInterval(heartbeat);
            await terminate();
            removeIsolatedRoot(dirs?.root);
        },
    });
}

/** Uses an OpenCode server someone else runs (OPENCODE_SERVER_URL). */
export function createAttachedBackend({ url, username, password, logger }) {
    const client = createOpencodeClient({ baseUrl: url, username, password });
    const shownUrl = backendOrigin(url);
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
            if (!(await probe())) throw new Error(`OpenCode server at ${shownUrl} is not healthy (GET /global/health). Check the URL and credentials.`);
            logger.info(`Using OpenCode ${version || ''} at ${shownUrl}`.replace('  ', ' '));
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
