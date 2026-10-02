import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT_PREFIX = 'zengate-';
const OWNER_FILE = 'owner.pid';
const BACKEND_FILE = 'backend.pid';
/** Tells this gateway process apart from an earlier one that had the same pid. */
const INSTANCE_ID = crypto.randomBytes(8).toString('hex');
/**
 * A tree made in another pid namespace (another container sharing this
 * /tmp) cannot be judged by its pid, only by how recently its owner touched
 * it. Owners touch their tree every HEARTBEAT_MS.
 */
export const HEARTBEAT_MS = 30000;
const FOREIGN_STALE_MS = 4 * HEARTBEAT_MS;

function pidNamespace() {
    try {
        return fs.readlinkSync('/proc/self/ns/pid');
    } catch {
        return '';
    }
}
const PID_NAMESPACE = pidNamespace();

/** Environment variables the backend legitimately needs from the host. */
const PASSTHROUGH_ENV = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'SystemDrive',
    'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
];

/**
 * OpenCode configuration for the managed backend. Every tool permission is
 * "ask" (the tool stays advertised exactly as in stock OpenCode) and the
 * gateway answers every ask with "reject", so tools never run.
 *
 * `continue_loop_on_deny` hands each rejection back to the model instead of
 * ending the turn. OpenCode rejects every other pending request of a session
 * along with the one answered, and without it those plain rejections stop
 * the turn before the model has written an answer.
 */
export function backendConfig() {
    return {
        $schema: 'https://opencode.ai/config.json',
        autoupdate: false,
        share: 'disabled',
        snapshot: false,
        permission: {
            '*': 'ask', read: 'ask', edit: 'ask', bash: 'ask', glob: 'ask', grep: 'ask', list: 'ask',
            task: 'ask', webfetch: 'ask', websearch: 'ask', external_directory: 'ask', skill: 'ask', lsp: 'ask',
        },
        experimental: { continue_loop_on_deny: true },
    };
}

/**
 * Create a private (0700) scratch tree: an empty workspace plus a fake
 * home/XDG layout, so the backend never reads the host user's OpenCode or
 * Claude config, skills, agents, credentials or projects.
 */
export function createIsolatedRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), ROOT_PREFIX));
    if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
    const dirs = {};
    for (const name of ['home', 'workspace', 'data', 'config', 'cache', 'state']) {
        dirs[name] = path.join(root, name);
        fs.mkdirSync(dirs[name], { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(path.join(root, OWNER_FILE), `${process.pid}\n${INSTANCE_ID}\n${PID_NAMESPACE}\n`, { mode: 0o600 });
    return { root, ...dirs };
}

/** Mark a tree as still in use (see HEARTBEAT_MS). */
export function touchIsolatedRoot(root) {
    try {
        const now = new Date();
        fs.utimesSync(path.join(root, OWNER_FILE), now, now);
    } catch {
        // The tree is gone or being removed.
    }
}

/** Remember the backend's pid so a later start can stop it if this gateway dies first. */
export function recordBackendPid(root, pid) {
    try {
        fs.writeFileSync(path.join(root, BACKEND_FILE), String(pid), { mode: 0o600 });
    } catch {
        // Only orphan cleanup depends on it.
    }
}

export function removeIsolatedRoot(root) {
    if (!root || !path.basename(root).startsWith(ROOT_PREFIX)) return;
    try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
        // A backend that is still exiting may hold files open; the next start sweeps it.
    }
}

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

/** Only trees this user created are swept; another user's look-alike in a shared /tmp is left alone. */
function ownedByUs(root) {
    if (typeof process.getuid !== 'function') return true;
    try {
        const stat = fs.lstatSync(root);
        return stat.isDirectory() && stat.uid === process.getuid();
    } catch {
        return false;
    }
}

function readOwner(root) {
    try {
        const file = path.join(root, OWNER_FILE);
        const [pid, instance = '', namespace = ''] = fs.readFileSync(file, 'utf8').split('\n');
        return { pid: Number(pid), instance: instance.trim(), namespace: namespace.trim(), touchedAt: fs.statSync(file).mtimeMs };
    } catch {
        return null;
    }
}

/**
 * A tree is stale when its gateway is gone. A container restart reuses the
 * same pid (often 1), so a tree with our pid but another instance id is
 * stale too. Trees from another pid namespace are stale once their owner
 * stops touching them.
 */
function isStale(owner) {
    if (!owner || !(owner.pid > 0)) return false;
    if (owner.namespace && owner.namespace !== PID_NAMESPACE) return Date.now() - owner.touchedAt > FOREIGN_STALE_MS;
    if (owner.pid === process.pid) return owner.instance !== INSTANCE_ID;
    return !isAlive(owner.pid);
}

/**
 * Stop the OpenCode backend a dead gateway left running (Linux only: the
 * process must still be working in that tree, so an unrelated process that
 * reused the pid is never touched).
 */
function stopOrphanBackend(root) {
    if (process.platform !== 'linux') return;
    try {
        const pid = Number(fs.readFileSync(path.join(root, BACKEND_FILE), 'utf8'));
        if (!(pid > 1) || fs.readlinkSync(`/proc/${pid}/cwd`) !== path.join(root, 'workspace')) return;
        try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
    } catch {
        // No pid file, or the backend is already gone.
    }
}

/** Remove scratch trees, and stop backends, left behind by gateway processes that no longer exist. */
export function sweepStaleRoots() {
    let entries = [];
    try {
        entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
    } catch {
        return 0;
    }
    let removed = 0;
    for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(ROOT_PREFIX)) continue;
        const root = path.join(os.tmpdir(), entry.name);
        if (!ownedByUs(root) || !isStale(readOwner(root))) continue;
        stopOrphanBackend(root);
        removeIsolatedRoot(root);
        removed += 1;
    }
    return removed;
}

/** Minimal child environment: no gateway secrets, isolated homes, stock OpenCode behavior. */
export function backendEnv(dirs, password) {
    const env = {};
    for (const key of PASSTHROUGH_ENV) if (process.env[key] !== undefined) env[key] = process.env[key];
    return {
        ...env,
        HOME: dirs.home,
        USERPROFILE: dirs.home,
        APPDATA: path.join(dirs.home, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(dirs.home, 'AppData', 'Local'),
        XDG_DATA_HOME: dirs.data,
        XDG_CONFIG_HOME: dirs.config,
        XDG_CACHE_HOME: dirs.cache,
        XDG_STATE_HOME: dirs.state,
        OPENCODE_SERVER_USERNAME: 'opencode',
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(backendConfig()),
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_SHARE: '1',
        OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_DISABLE_CLAUDE_CODE: '1',
        OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
        OPENCODE_DISABLE_EMBEDDED_WEB_UI: '1',
    };
}

export const randomPassword = () => crypto.randomBytes(32).toString('base64url');
