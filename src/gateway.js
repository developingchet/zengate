import { createAttachedBackend, createManagedBackend } from './opencode/backend.js';
import { createCatalog } from './opencode/catalog.js';
import { createEventHub } from './opencode/events.js';
import { createRunner } from './opencode/runner.js';
import { createResponsesStore } from './openai/responses-store.js';
import { createApp } from './server/app.js';

const HUB_CONNECT_TIMEOUT_MS = 10000;
const DRAIN_TIMEOUT_MS = 10000;

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

function drain(server) {
    return new Promise((resolve) => {
        const force = setTimeout(() => server.closeAllConnections(), DRAIN_TIMEOUT_MS);
        force.unref();
        server.close(() => { clearTimeout(force); resolve(); });
        server.closeIdleConnections();
    });
}

/**
 * Wires the OpenCode backend, event hub, catalog and HTTP app together and
 * starts listening.
 * @param {object} config validated config from loadConfig
 * @param {{ logger: object, backend?: object }} deps backend is injectable for tests
 */
export async function startGateway(config, { logger, backend = createBackend(config, logger) }) {
    const getClient = () => backend.getClient();
    const hub = createEventHub({ getClient, logger, ownsAllSessions: backend.ownsAllSessions });
    const catalog = createCatalog({ getClient, logger });
    const runner = createRunner({ getClient, hub, logger, agent: config.OPENCODE_AGENT });
    const store = createResponsesStore({ maxEntries: config.RESPONSES_STORE_MAX });
    const { app, close: closeApp } = createApp({ config, logger, backend, hub, catalog, runner, store });

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
    // Generations can legitimately run for minutes; REQUEST_TIMEOUT_MS bounds them instead.
    server.requestTimeout = 0;
    server.headersTimeout = 30000;
    server.keepAliveTimeout = 65000;

    let stopping = null;
    const stop = () => {
        stopping ??= (async () => {
            await drain(server);
            closeApp();
            await hub.stop();
            await backend.stop();
        })();
        return stopping;
    };

    return Object.freeze({ server, stop, address: server.address(), backend });
}
