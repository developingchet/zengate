import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT_PREFIX = 'zengate-';

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
    fs.writeFileSync(path.join(root, 'owner.pid'), String(process.pid), { mode: 0o600 });
    return { root, ...dirs };
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

/** Remove scratch trees left behind by gateway processes that no longer exist. */
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
        let pid = 0;
        try { pid = Number(fs.readFileSync(path.join(root, 'owner.pid'), 'utf8')); } catch { /* unreadable: leave it */ }
        if (pid > 0 && pid !== process.pid && !isAlive(pid)) {
            removeIsolatedRoot(root);
            removed += 1;
        }
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
