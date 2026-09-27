import { generateApiKey, writeConfigFile } from './bootstrap.js';
import { readConfigFile } from './config.js';

const SETUP_FLAGS = new Set(['--rotate', '--print']);

export const HELP_TEXT = `zengate: an OpenAI-compatible API for OpenCode's free Zen models

Usage:
  zengate                   start the gateway (creates an API key on first start)
  zengate setup             create config.json with an API key (keeps an existing key)
  zengate setup --rotate    replace the API key
  zengate setup --print     print a fresh key without saving it
  zengate --version         print the version
  zengate --help            show this help

Settings come from environment variables or config.json.
Docs: https://github.com/developingchet/zengate#readme`;

/**
 * @param {string[]} args command-line arguments after the script name
 * @returns {{ command: 'serve'|'setup'|'help'|'version'|'unknown', flags: string[] }}
 */
export function parseCommand(args) {
    const [first, ...rest] = args;
    if (first === undefined) return { command: 'serve', flags: [] };
    if (['--help', '-h', 'help'].includes(first)) return { command: 'help', flags: [] };
    if (['--version', '-v', 'version'].includes(first)) return { command: 'version', flags: [] };
    if (first === 'setup' && rest.every((flag) => SETUP_FLAGS.has(flag))) return { command: 'setup', flags: rest };
    return { command: 'unknown', flags: args };
}

/**
 * Create, keep or rotate the gateway API key in config.json.
 * @param {{ configPath: string, flags: string[], out: (line?: string) => void }} options
 * @returns {number} process exit code
 */
export function runSetup({ configPath, flags, out }) {
    if (flags.includes('--print')) {
        out(generateApiKey());
        return 0;
    }
    const current = readConfigFile(configPath);
    if (current.API_KEY && !flags.includes('--rotate')) {
        out(`${configPath} already has an API_KEY. Use --rotate to replace it.`);
        return 0;
    }
    const key = generateApiKey();
    writeConfigFile(configPath, { ...current, API_KEY: key });
    out(`Saved a new API key to ${configPath}:`);
    out();
    out(`  ${key}`);
    out();
    out('Restart the gateway if it is running.');
    return 0;
}
