import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, isLoopbackHost, loadConfig, needsApiKey, readConfigFile } from './config.js';

export const KEY_PREFIX = 'sk-zg-';

export function generateApiKey() {
    return `${KEY_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
}

/** Write config.json with owner-only permissions (atomic rename), creating its directory if needed. */
export function writeConfigFile(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 4)}\n`, { mode: 0o600 });
    fs.renameSync(temp, filePath);
}

/**
 * Load the config, provisioning a gateway API key on first run so that a
 * fresh `npm start` is secure by default without any manual setup.
 * @param {{ configPath: string, env?: object, logger: object, print?: (line: string) => void }} options
 * @returns {object} validated, frozen config
 */
export function loadOrProvisionConfig({ configPath, env = process.env, logger, print = (line) => process.stdout.write(`${line}\n`) }) {
    const fileConfig = readConfigFile(configPath);
    const config = loadConfig(fileConfig, env);
    if (!needsApiKey(config)) return config;

    const key = generateApiKey();
    try {
        writeConfigFile(configPath, { ...fileConfig, API_KEY: key });
    } catch (error) {
        throw new ConfigError([
            `no API_KEY is configured and ${configPath} could not be written (${error.code || error.message}).`,
            'Set API_KEY (at least 16 characters, e.g. from `zengate setup --print`) in the environment, or set CONFIG_FILE to a writable path,',
            'or set ALLOW_NO_AUTH=true to deliberately serve without a key.',
        ]);
    }
    print('');
    print(`  Created a gateway API key (saved to ${configPath}):`);
    print('');
    print(`    ${key}`);
    print('');
    print('  Use it as the OpenAI API key in your client. It is not shown again;');
    print('  read it from that file, or run `zengate setup --rotate` to replace it.');
    print('');
    logger.debug('Provisioned a new API key', { configPath });
    return loadConfig({ ...fileConfig, API_KEY: key }, env);
}

/** Startup warnings for configurations that are allowed but risky. */
export function securityWarnings(config) {
    const warnings = [];
    const exposed = !isLoopbackHost(config.HOST);
    if (config.ALLOW_NO_AUTH) {
        warnings.push(exposed
            ? `ALLOW_NO_AUTH is on and HOST=${config.HOST}: anyone who can reach this port can use the gateway.`
            : 'ALLOW_NO_AUTH is on: any local process or web page can use the gateway.');
    }
    if (exposed && !config.ALLOW_NO_AUTH) {
        warnings.push(`Listening on ${config.HOST}. Traffic is plain HTTP; put TLS (a reverse proxy) in front before exposing it beyond a trusted network.`);
    }
    return warnings;
}
