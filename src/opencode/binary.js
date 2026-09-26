import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function isFile(file) {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

/** The binary shipped by the official `opencode-ai` npm package (a dependency). */
function bundledBinary() {
    try {
        const root = path.dirname(require.resolve('opencode-ai/package.json'));
        const binary = path.join(root, 'bin', 'opencode.exe');
        return isFile(binary) ? binary : null;
    } catch {
        return null;
    }
}

function searchPath(names) {
    for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)) {
        for (const name of names) {
            const candidate = path.join(dir, name);
            if (isFile(candidate)) return candidate;
        }
    }
    return null;
}

/**
 * Locate the OpenCode CLI: explicit OPENCODE_PATH, then the bundled
 * `opencode-ai` package, then PATH. Never guesses other directories.
 * @param {string} configured OPENCODE_PATH ('' for automatic)
 * @returns {{ path: string, source: 'config'|'bundled'|'PATH' }}
 */
export function resolveOpencodeBinary(configured) {
    const windowsNames = ['opencode.exe', 'opencode.cmd', 'opencode.bat', 'opencode'];
    if (configured) {
        const looksLikePath = configured.includes('/') || configured.includes('\\');
        if (looksLikePath) {
            const full = path.resolve(configured);
            if (isFile(full)) return { path: full, source: 'config' };
            throw new Error(`OPENCODE_PATH does not point to a file: ${full}`);
        }
        const names = process.platform === 'win32' ? windowsNames.map((n) => n.replace('opencode', configured)) : [configured];
        const found = searchPath(names);
        if (found) return { path: found, source: 'config' };
        throw new Error(`OPENCODE_PATH '${configured}' was not found on PATH`);
    }
    const bundled = bundledBinary();
    if (bundled) return { path: bundled, source: 'bundled' };
    const found = searchPath(process.platform === 'win32' ? windowsNames : ['opencode']);
    if (found) return { path: found, source: 'PATH' };
    throw new Error('OpenCode CLI not found. Run `npm ci` (it installs the bundled opencode-ai package) or set OPENCODE_PATH.');
}

/**
 * Build spawn arguments. Windows .cmd/.bat shims need cmd.exe; the command
 * line is fully quoted and every argument is gateway-controlled.
 */
export function spawnCommand(binary, args) {
    const lower = binary.toLowerCase();
    if (process.platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'))) {
        if (/["\r\n%]/.test(binary)) throw new Error('OPENCODE_PATH contains characters that cannot be run safely');
        const line = [`"${binary}"`, ...args.map((arg) => `"${arg}"`)].join(' ');
        return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
    }
    return { command: binary, args, windowsVerbatimArguments: false };
}
