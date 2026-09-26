import { ApiError } from '../server/errors.js';
import { mapBackendError, mapModelError } from './model-errors.js';

const MESSAGE_SEPARATOR = '\n\n';
const MAX_UPSTREAM_RETRIES = 3;
const NATIVE_ATTEMPT = Symbol('native-client-tool-attempt');
const STREAMED_KINDS = new Set(['text', 'reasoning']);

/**
 * Runs one prompt in a throwaway OpenCode session and streams its output.
 *
 * Deltas arrive over the shared event hub while the blocking prompt call is
 * pending; when it returns, the final message is reconciled against what was
 * streamed so no text is lost or duplicated even if events were missed.
 */
export function createRunner({ getClient, hub, logger, agent }) {
    /**
     * @param {{ model: { providerID: string, modelID: string }, system?: string, parts: object[], variant?: string, format?: object }} request
     * @param {{ signal: AbortSignal, onDelta?: (kind: 'text'|'reasoning', text: string) => void }} options
     */
    async function run(request, { signal: outer, onDelta = () => {} }) {
        let signal = outer;
        const client = getClient();
        let sessionId;
        try {
            sessionId = (await client.createSession({ signal }))?.id;
        } catch (error) {
            throw mapBackendError(error);
        }
        if (!sessionId) throw mapBackendError(new Error('OpenCode did not return a session id'));

        // Local controller: aborts on the caller's signal, or when OpenCode
        // keeps retrying a failing upstream (it would otherwise retry until
        // REQUEST_TIMEOUT_MS).
        const local = new AbortController();
        const forward = () => local.abort(outer.reason);
        if (signal.aborted) forward();
        else signal.addEventListener('abort', forward, { once: true });
        const tracker = createStreamTracker(onDelta);
        const clientTools = new Set(request.clientTools || []);
        let nativeAttempt = null;
        const onEvent = (event) => {
            tracker.handle(event);
            const part = event.type === 'message.part.updated' ? event.properties?.part : null;
            const attempted = part?.type === 'tool' ? invalidToolName(part, clientTools) : null;
            if (attempted !== null && !local.signal.aborted) {
                // The model called a client function (or a nonexistent tool)
                // natively. Letting OpenCode continue only produces a detour
                // (and trips some providers), so stop; generate() retries.
                logger.debug('Model attempted a native call to a non-OpenCode tool', { sessionId, tool: attempted });
                nativeAttempt = attempted || 'unnamed tool';
                local.abort(NATIVE_ATTEMPT);
                return;
            }
            const status = event.type === 'session.status' ? event.properties?.status : null;
            if (status?.type !== 'retry') return;
            logger.debug('OpenCode is retrying the upstream request', { sessionId, attempt: status.attempt, message: status.message });
            if (status.attempt >= MAX_UPSTREAM_RETRIES && !local.signal.aborted) {
                local.abort(new ApiError(502, `The model provider keeps failing: ${String(status.message || 'unknown error').slice(0, 300)}`, { code: 'upstream_error' }));
            }
        };
        const unsubscribe = hub.subscribe(sessionId, onEvent);
        const abortSession = () => { client.abortSession(sessionId).catch(() => {}); };
        local.signal.addEventListener('abort', abortSession, { once: true });
        signal = local.signal;
        try {
            const body = {
                model: request.model,
                agent,
                parts: request.parts,
                ...(request.system ? { system: request.system } : {}),
                ...(request.variant ? { variant: request.variant } : {}),
                ...(request.format ? { format: request.format } : {}),
            };
            let last;
            try {
                last = await client.prompt(sessionId, body, { signal });
            } catch (error) {
                if (nativeAttempt && signal.reason === NATIVE_ATTEMPT) {
                    return { text: '', reasoning: '', usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0 }, finish: 'stop', nativeToolAttempt: nativeAttempt };
                }
                if (signal.aborted) throw signal.reason ?? error;
                throw mapBackendError(error);
            }
            // Several assistant messages mean OpenCode continued after a
            // rejected tool; without live events we cannot know, so re-read.
            const assistantMessages = tracker.assistantCount() > 1 || !hub.isConnected()
                ? (await client.messages(sessionId, { signal })).filter((m) => m?.info?.role === 'assistant')
                : [last];
            const result = summarize(assistantMessages);
            tracker.flushRemainder(result);
            return result;
        } finally {
            local.signal.removeEventListener('abort', abortSession);
            outer.removeEventListener('abort', forward);
            unsubscribe();
            void cleanup(client, sessionId);
        }
    }

    async function cleanup(client, sessionId) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                await client.deleteSession(sessionId);
                break;
            } catch (error) {
                if (attempt === 1) logger.debug('Could not delete OpenCode session', { sessionId, error: error.message });
            }
        }
        hub.release(sessionId);
    }

    return Object.freeze({ run });
}

/** Tracks part kinds and message roles so only assistant text/reasoning streams. */
function createStreamTracker(onDelta) {
    const partKinds = new Map();
    const pendingDeltas = new Map();
    const roles = new Map();
    const streamed = { text: '', reasoning: '' };
    const lastMessage = { text: null, reasoning: null };

    const emit = (kind, messageId, delta) => {
        if (!delta) return;
        const separator = streamed[kind] && lastMessage[kind] !== messageId ? MESSAGE_SEPARATOR : '';
        lastMessage[kind] = messageId;
        streamed[kind] += separator + delta;
        onDelta(kind, separator + delta);
    };

    const flushPart = (partId) => {
        const queued = pendingDeltas.get(partId);
        const kind = partKinds.get(partId);
        if (!queued || !kind) return;
        pendingDeltas.delete(partId);
        if (STREAMED_KINDS.has(kind)) for (const { messageId, delta } of queued) emit(kind, messageId, delta);
    };

    function handle(event) {
        const props = event.properties || {};
        if (event.type === 'message.updated' && props.info?.id) {
            roles.set(props.info.id, props.info.role);
        } else if (event.type === 'message.part.updated' && props.part?.id) {
            partKinds.set(props.part.id, props.part.type);
            flushPart(props.part.id);
        } else if (event.type === 'message.part.delta' && props.field === 'text' && typeof props.delta === 'string') {
            if (roles.get(props.messageID) === 'user') return;
            const queued = pendingDeltas.get(props.partID) || [];
            queued.push({ messageId: props.messageID, delta: props.delta });
            pendingDeltas.set(props.partID, queued);
            flushPart(props.partID);
        }
    }

    function flushRemainder(result) {
        for (const kind of STREAMED_KINDS) {
            const finalText = result[kind];
            if (finalText.startsWith(streamed[kind])) {
                const rest = finalText.slice(streamed[kind].length);
                if (rest) {
                    streamed[kind] = finalText;
                    onDelta(kind, rest);
                }
            }
        }
    }

    return {
        handle,
        flushRemainder,
        assistantCount: () => [...roles.values()].filter((role) => role === 'assistant').length,
    };
}

/**
 * Name of the tool the model tried to call when it is not an OpenCode tool:
 * a pending part already named after a client function, or OpenCode's
 * `invalid` stand-in. Returns null for ordinary OpenCode tool parts.
 */
function invalidToolName(part, clientTools) {
    if (clientTools.has(part.tool)) return part.tool;
    if (part.tool === 'invalid') return String(part.state?.input?.tool ?? '');
    return null;
}

function joinParts(messages, type) {
    return messages
        .map((message) => (message.parts || []).filter((p) => p?.type === type).map((p) => p.text || '').join(''))
        .filter(Boolean)
        .join(MESSAGE_SEPARATOR);
}

/** Collapse the turn's assistant messages into text, reasoning, usage and finish. */
function summarize(messages) {
    const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0 };
    let error = null;
    let structured;
    for (const message of messages) {
        const tokens = message?.info?.tokens || {};
        usage.input += tokens.input || 0;
        usage.output += tokens.output || 0;
        usage.reasoning += tokens.reasoning || 0;
        usage.cacheRead += tokens.cache?.read || 0;
        if (message?.info?.error) error = message.info.error;
        if (message?.info?.structured !== undefined) structured = message.info.structured;
    }
    const last = messages[messages.length - 1]?.info || {};
    const mapped = error ? mapModelError(error) : null;
    if (mapped?.throw) throw mapped.throw;
    return {
        text: joinParts(messages, 'text'),
        reasoning: joinParts(messages, 'reasoning'),
        structured,
        usage,
        finish: mapped?.finish || normalizeFinish(last.finish),
    };
}

function normalizeFinish(finish) {
    if (finish === 'length') return 'length';
    if (finish === 'content-filter') return 'content_filter';
    return 'stop';
}
