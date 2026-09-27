import os from 'node:os';
import path from 'node:path';

const APP_DIR = 'zengate';
const CONFIG_NAME = 'config.json';

/**
 * True when the code runs from an installed npm package (npm -g, npx or a
 * dependency) rather than a source checkout.
 * @param {string} root package root directory
 * @returns {boolean}
 */
export function isInstalledPackage(root) {
    return root.split(/[\\/]+/).includes('node_modules');
}

/**
 * The per-user config directory for this platform.
 * @param {{ env: object, platform: string, homedir: string }} options
 * @returns {string}
 */
function userConfigDir({ env, platform, homedir }) {
    if (platform === 'win32') return path.join(env.APPDATA || path.join(homedir, 'AppData', 'Roaming'), APP_DIR);
    if (platform === 'darwin') return path.join(homedir, 'Library', 'Application Support', APP_DIR);
    const xdg = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(homedir, '.config');
    return path.join(xdg, APP_DIR);
}

/**
 * Where config.json lives: CONFIG_FILE if set, next to the code in a source
 * checkout, otherwise the per-user config directory (an installed package
 * directory may be read-only and is replaced on every upgrade).
 * @param {{ root: string, env?: object, platform?: string, homedir?: string }} options
 * @returns {string}
 */
export function defaultConfigPath({ root, env = process.env, platform = process.platform, homedir = os.homedir() }) {
    if (env.CONFIG_FILE) return env.CONFIG_FILE;
    if (!isInstalledPackage(root)) return path.join(root, CONFIG_NAME);
    return path.join(userConfigDir({ env, platform, homedir }), CONFIG_NAME);
}
