const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

/**
 * Small leveled logger. Human-readable by default, JSON lines when json=true.
 * Callers pass structured fields; request bodies and secrets are never logged.
 * @param {{ level?: keyof LEVELS, json?: boolean, sink?: { out: Function, err: Function } }} [options]
 */
export function createLogger({ level = 'info', json = false, sink } = {}) {
    const threshold = LEVELS[level] ?? LEVELS.info;
    const out = sink?.out ?? ((line) => process.stdout.write(`${line}\n`));
    const err = sink?.err ?? ((line) => process.stderr.write(`${line}\n`));

    const write = (name, message, fields) => {
        if (LEVELS[name] < threshold) return;
        const target = LEVELS[name] >= LEVELS.warn ? err : out;
        if (json) {
            target(JSON.stringify({ ts: new Date().toISOString(), level: name, msg: message, ...fields }));
            return;
        }
        const extra = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
        const tag = name === 'info' ? '' : `[${name}] `;
        target(`${tag}${message}${extra}`);
    };

    return Object.freeze({
        debug: (message, fields) => write('debug', message, fields),
        info: (message, fields) => write('info', message, fields),
        warn: (message, fields) => write('warn', message, fields),
        error: (message, fields) => write('error', message, fields),
        isDebug: threshold <= LEVELS.debug,
    });
}

/** Logger that discards everything; handy for tests and embedding. */
export const silentLogger = createLogger({ level: 'error', sink: { out: () => {}, err: () => {} } });
