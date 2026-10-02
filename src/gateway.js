import { createAttachedBackend, createManagedBackend } from './opencode/backend.js';
import { createCatalog } from './opencode/catalog.js';
import { createEventHub } from './opencode/events.js';
import { createRunner } from './opencode/runner.js';
import { createResponsesStore } from './openai/responses-store.js';
import { createApp } from './server/app.js';

const HUB_CONNECT_TIMEOUT_MS = 10000;
const MB = 1024 * 1024;
// Time allowed to receive a whole request (headers and body). Generation
// time is not included; REQUEST_TIMEOUT_MS bounds that.
const BODY_TIMEOUT_MS = 120000;
const SHUTDOWN_NOTICE_MS = 2000;

export function createBackend(config, logger) {
    return config.OPENCODE_SERVER_URL
        ? createAttachedBackend({
            url: config.OPENCODE_SERVER_URL,
            username: config.OPENCODE_SERVER_USERNAME,
            password: config.OPENCODE_SERVER_PASSWORD,
            logger,
        })
        : createManagedBackend({ opencodePath: config.OPENCODE_PATH, logger });
}

function listen(app, { PORT, HOST }) {
    return new Promise((resolve, reject) => {
        const server = app.listen(PORT, HOST);
        server.once('listening', () => resolve(server));
        server.once('error', (error) => reject(error.code === 'EADDRINUSE'
            ? new Error(`Port ${PORT} on ${HOST} is already in use. Stop the other process or set PORT.`)
            : error));
    });
}

const openConnections = (server) => new Promise((resolve) => {
    server.getConnections((error, count) => resolve(error ? 0 : count));
});

/**
 * Keep listening for `noticeMs` while /ready reports "stopping", so a load
 * balancer that polls it stops routing here before the listener closes.
 * Skipped when nobody is connected, so a local Ctrl+C stays instant.
 * @returns {Promise<number>} how long it waited
 */
async function announceShutdown(server, noticeMs) {
    if (noticeMs <= 0 || (await openConnections(server)) === 0) return 0;
    await new Promise((resolve) => setTimeout(resolve, noticeMs));
    return noticeMs;
}

function drain(server, timeoutMs) {
    return new Promise((resolve) => {
        const force = setTimeout(() => server.closeAllConnections(), timeoutMs);
        force.unref();
        server.close(() => { clearTimeout(force); resolve(); });
        server.closeIdleConnections();
    });
}

/**
 * Wires the OpenCode backend, event hub, catalog and HTTP app together and
 * starts listening.
 * @param {object} config validated config from loadConfig
 * @param {{ logger: object, backend?: object, shutdownNoticeMs?: number }} deps backend and notice are injectable for tests
 */
export async function startGateway(config, { logger, backend = createBackend(config, logger), shutdownNoticeMs = SHUTDOWN_NOTICE_MS }) {
    const getClient = () => backend.getClient();
    const hub = createEventHub({ getClient, logger, ownsAllSessions: backend.ownsAllSessions });
    const catalog = createCatalog({ getClient, logger });
    const runner = createRunner({ getClient, hub, logger, agent: config.OPENCODE_AGENT });
    const store = createResponsesStore({ maxEntries: config.RESPONSES_STORE_MAX, maxChars: config.RESPONSES_STORE_MB * MB });
    const { app, close: closeApp, startDraining } = createApp({ config, logger, backend, hub, catalog, runner, store });

    await backend.start();
    let server;
    try {
        hub.start();
        if (!(await hub.waitConnected(HUB_CONNECT_TIMEOUT_MS))) {
            logger.warn('OpenCode event stream is not connected yet; streaming falls back to final output until it is');
        }
        catalog.list().then(
            (models) => logger.info(`${models.length} models: ${models.map((m) => m.id).join(', ')}`),
            (error) => logger.warn('Could not load the model list yet', { error: error.message }),
        );
        server = await listen(app, config);
    } catch (error) {
        await hub.stop();
        closeApp();
        await backend.stop();
        throw error;
    }
    server.requestTimeout = BODY_TIMEOUT_MS;
    server.headersTimeout = 30000;
    server.keepAliveTimeout = 65000;

    let stopping = null;
    const stop = () => {
        stopping ??= (async () => {
            startDraining();
            // In-flight requests keep running during the notice, so it counts towards SHUTDOWN_TIMEOUT_MS.
            const noticed = await announceShutdown(server, Math.min(shutdownNoticeMs, config.SHUTDOWN_TIMEOUT_MS / 2));
            await drain(server, config.SHUTDOWN_TIMEOUT_MS - noticed);
            closeApp();
            await hub.stop();
            await backend.stop();
        })();
        return stopping;
    };

    return Object.freeze({ server, stop, address: server.address(), backend });
}
