#!/usr/bin/env node
// Gateway key helper.
//   npm run setup               create config.json with a key (keeps an existing key)
//   npm run setup -- --rotate   replace the key in config.json
//   npm run setup -- --print    only print a fresh key (for env vars / secret stores)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateApiKey, writeConfigFile } from '../src/bootstrap.js';
import { readConfigFile } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.env.CONFIG_FILE || path.join(root, 'config.json');
const args = new Set(process.argv.slice(2));
const out = (line = '') => process.stdout.write(`${line}\n`);

try {
    if (args.has('--print')) {
        out(generateApiKey());
    } else {
        const current = readConfigFile(configPath);
        if (current.API_KEY && !args.has('--rotate')) {
            out(`config.json already has an API_KEY. Use --rotate to replace it.`);
        } else {
            const key = generateApiKey();
            writeConfigFile(configPath, { ...current, API_KEY: key });
            out(`Saved a new API key to ${configPath}:`);
            out();
            out(`  ${key}`);
            out();
            out('Restart the gateway if it is running.');
        }
    }
} catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
}
