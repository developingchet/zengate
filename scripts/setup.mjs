#!/usr/bin/env node
// Gateway key helper (same as `zengate setup`).
//   npm run setup               create config.json with a key (keeps an existing key)
//   npm run setup -- --rotate   replace the key in config.json
//   npm run setup -- --print    only print a fresh key (for env vars / secret stores)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommand, runSetup } from '../src/cli.js';
import { defaultConfigPath } from '../src/paths.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { command, flags } = parseCommand(['setup', ...process.argv.slice(2)]);

if (command !== 'setup') {
    process.stderr.write(`Unknown option: ${process.argv.slice(2).join(' ')}. Use --rotate or --print.\n`);
    process.exitCode = 2;
} else {
    try {
        process.exitCode = runSetup({ configPath: defaultConfigPath({ root }), flags, out: (line = '') => process.stdout.write(`${line}\n`) });
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
