#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrProvisionConfig, securityWarnings } from './src/bootstrap.js';
import { HELP_TEXT, parseCommand, runSetup } from './src/cli.js';
import { ConfigError } from './src/config.js';
import { startGateway } from './src/gateway.js';
import { createLogger } from './src/logger.js';
import { defaultConfigPath } from './src/paths.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const configPath = defaultConfigPath({ root });
const out = (line = '') => process.stdout.write(`${line}\n`);

/** Handle the non-server commands. Returns an exit code, or null to start the server. */
function runCommand(args) {
    const { command, flags } = parseCommand(args);
    if (command === 'serve') return null;
    if (command === 'help') {
        out(HELP_TEXT);
        return 0;
    }
    if (command === 'version') {
        out(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
        return 0;
    }
    if (command === 'setup') {
        try {
            return runSetup({ configPath, flags, out });
        } catch (error) {
            process.stderr.write(`${error.message}\n`);
            return 1;
        }
    }
    process.stderr.write(`Unknown arguments: ${args.join(' ')}\n\n${HELP_TEXT}\n`);
    return 2;
}

async function main() {
    const exitCode = runCommand(process.argv.slice(2));
    if (exitCode !== null) {
        process.exitCode = exitCode;
        return;
    }
    const bootLogger = createLogger({ level: process.env.LOG_LEVEL || 'info', json: /^(1|true|yes|on)$/i.test(process.env.LOG_JSON || '') });
    let config;
    try {
        config = loadOrProvisionConfig({ configPath, logger: bootLogger });
    } catch (error) {
        bootLogger.error(error instanceof ConfigError ? error.message : `Could not load configuration: ${error.message}`);
        process.exit(1);
    }
    const logger = createLogger({ level: config.LOG_LEVEL, json: config.LOG_JSON });
    securityWarnings(config).forEach((warning) => logger.warn(warning));

    let gateway;
    try {
        gateway = await startGateway(config, { logger });
    } catch (error) {
        logger.error(`Startup failed: ${error.message}`);
        process.exit(1);
    }
    const { address, port } = gateway.address;
    const host = address.includes(':') ? `[${address}]` : address;
    logger.info(`OpenAI-compatible API on http://${host}:${port}/v1 (auth: ${config.ALLOW_NO_AUTH ? 'OFF' : 'API key'})`);

    let shuttingDown = false;
    const shutdown = (signal) => {
        if (shuttingDown) {
            process.exit(1);
        }
        shuttingDown = true;
        logger.info(`${signal} received; finishing in-flight requests`);
        gateway.stop().then(() => process.exit(0), (error) => {
            logger.error('Shutdown error', { error: error.message });
            process.exit(1);
        });
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
