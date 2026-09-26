import { readSseFrames } from './sse-reader.js';

/**
 * Sent back to the model whenever it tries to use an OpenCode tool. OpenCode
 * lets the turn continue with this feedback, so the model answers directly.
 */
export const TOOL_REJECTION_MESSAGE = 'OpenCode tools are disabled by this gateway. Do not call OpenCode tools; answer directly. '
    + 'If the user supplied their own functions, use the function-call format described in the system instructions.';

const MAX_BACKOFF_MS = 5000;

async function* readChunks(reader) {
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
    }
}

/**
 * One shared subscription to the backend's /event stream, fanned out to
 * per-session listeners. It also enforces the gateway's security policy:
 * every OpenCode tool permission request and question from a gateway session
 * is rejected, so no command, file edit or fetch ever runs on the host.
 *
 * @param {{ getClient: () => ReturnType<import('./client.js').createOpencodeClient>, logger: any, ownsAllSessions: boolean }} options
 */
export function createEventHub({ getClient, logger, ownsAllSessions }) {
    const listeners = new Map();
    const owned = new Set();
    const children = new Map();
    let connected = false;
    let stopped = false;
    let controller = null;
    let connectedWaiters = [];
    let loop = null;

    const isOurs = (sessionId) => ownsAllSessions || owned.has(sessionId);

    function setConnected(value) {
        connected = value;
        if (value) {
            connectedWaiters.forEach((resolve) => resolve(true));
            connectedWaiters = [];
        }
    }

    async function rejectPermission(id, sessionId) {
        try {
            await getClient().replyPermission(id, 'reject', TOOL_REJECTION_MESSAGE);
            logger.debug('Rejected OpenCode tool permission', { sessionId });
        } catch (error) {
            logger.warn('Failed to reject an OpenCode tool permission', { sessionId, error: error.message });
        }
    }

    async function rejectQuestion(id, sessionId) {
        try {
            await getClient().rejectQuestion(id);
        } catch (error) {
            logger.warn('Failed to reject an OpenCode question', { sessionId, error: error.message });
        }
    }

    /** Sessions spawned by an owned session (e.g. subagents) are owned too. */
    function adoptChild(info) {
        if (!info?.id || !info.parentID || !owned.has(info.parentID) || owned.has(info.id)) return;
        owned.add(info.id);
        children.set(info.parentID, [...(children.get(info.parentID) || []), info.id]);
    }

    function dispatch(event) {
        const props = event?.properties || {};
        if (event.type === 'session.created' || event.type === 'session.updated') adoptChild(props.info);
        const sessionId = props.sessionID || props.info?.sessionID || props.part?.sessionID;
        if (event.type === 'permission.asked' && isOurs(sessionId)) void rejectPermission(props.id, sessionId);
        else if (event.type === 'question.asked' && isOurs(sessionId)) void rejectQuestion(props.id, sessionId);
        const set = sessionId ? listeners.get(sessionId) : null;
        if (!set) return;
        for (const listener of set) {
            try { listener(event); } catch (error) { logger.error('Event listener failed', { error: error.message }); }
        }
    }

    /** Catch permission requests raised while the stream was down. */
    async function sweepPending() {
        const client = getClient();
        for (const [list, reject] of [[client.pendingPermissions, rejectPermission], [client.pendingQuestions, rejectQuestion]]) {
            try {
                const pending = await list();
                for (const item of Array.isArray(pending) ? pending : []) {
                    if (item?.id && isOurs(item.sessionID)) await reject(item.id, item.sessionID);
                }
            } catch (error) {
                logger.debug('Pending request sweep failed', { error: error.message });
            }
        }
    }

    async function runLoop() {
        let backoff = 250;
        while (!stopped) {
            controller = new AbortController();
            try {
                const response = await getClient().openEvents(controller.signal);
                // fetch() can drop its abort link once its Request is garbage
                // collected, so stop() also cancels the body directly.
                const reader = response.body.getReader();
                controller.signal.addEventListener('abort', () => { reader.cancel().catch(() => {}); }, { once: true });
                setConnected(true);
                backoff = 250;
                void sweepPending();
                for await (const frame of readSseFrames(readChunks(reader))) {
                    let event;
                    try { event = JSON.parse(frame.data); } catch { continue; }
                    if (event && typeof event.type === 'string') dispatch(event);
                }
                if (!stopped) logger.warn('OpenCode event stream ended; reconnecting');
            } catch (error) {
                if (!stopped) logger.debug('OpenCode event stream unavailable', { error: error.message });
            }
            setConnected(false);
            if (stopped) break;
            await new Promise((resolve) => setTimeout(resolve, backoff).unref());
            backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
        }
    }

    return Object.freeze({
        start() {
            if (!loop) loop = runLoop();
        },
        /** Register a listener for one session; returns an unsubscribe function. */
        subscribe(sessionId, listener) {
            owned.add(sessionId);
            const set = listeners.get(sessionId) || new Set();
            set.add(listener);
            listeners.set(sessionId, set);
            return () => {
                set.delete(listener);
                if (set.size === 0) listeners.delete(sessionId);
            };
        },
        release(sessionId) {
            for (const child of children.get(sessionId) || []) owned.delete(child);
            children.delete(sessionId);
            owned.delete(sessionId);
            listeners.delete(sessionId);
        },
        isConnected: () => connected,
        waitConnected(timeoutMs) {
            if (connected) return Promise.resolve(true);
            return new Promise((resolve) => {
                const timer = setTimeout(() => {
                    connectedWaiters = connectedWaiters.filter((fn) => fn !== done);
                    resolve(false);
                }, timeoutMs);
                const done = (value) => { clearTimeout(timer); resolve(value); };
                connectedWaiters.push(done);
            });
        },
        async stop() {
            stopped = true;
            controller?.abort();
            await loop?.catch(() => {});
        },
    });
}
