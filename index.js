#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrProvisionConfig, securityWarnings } from './src/bootstrap.js';
import { ConfigError } from './src/config.js';
import { startGateway } from './src/gateway.js';
import { createLogger } from './src/logger.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.env.CONFIG_FILE || path.join(root, 'config.json');

async function main() {
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
