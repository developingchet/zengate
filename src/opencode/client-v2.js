import { BackendError, createHttp } from './http.js';
import { adaptEvent, messageFromV2, providersFromModels } from './v2-convert.js';
import { ApiError } from '../server/errors.js';
import { CHAT_PLUGIN_ID, CHAT_AGENT } from './chat-plugin.js';

const MESSAGE_PAGE = 200;
const MAX_PAGES = 5;
const POLL_MS = 250;
const AGENTS_CACHE_MS = 60000;
// OpenCode 2 caps an instruction entry at 256 KiB; stay under it.
const MAX_INSTRUCTION_BYTES = 200 * 1024;
const SYSTEM_ENTRY = 'gateway';
// Every action asks (the gateway rejects each request; an ask nobody answers
// blocks the tool, it never runs). Two actions are denied outright:
// - `execute`: the code-mode tool runs scripts in the OpenCode process, and
//   their built-in `fetch` reaches any URL without a permission request.
//   Denying it with resource `*` removes the tool from the model's list.
// - `browser`: browser tools only work through a desktop app attached to the session.
// A deny-all ruleset is avoided: it makes Zen's free tier refuse every request.
const SESSION_PERMISSIONS = Object.freeze([
    { action: '*', resource: '*', effect: 'ask' },
    { action: 'execute', resource: '*', effect: 'deny' },
    { action: 'browser', resource: '*', effect: 'deny' },
]);

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** The text of a prompt's parts, and its attachments in OpenCode 2's `files` form. */
function splitParts(parts = []) {
    const text = parts.filter((part) => part?.type === 'text').map((part) => part.text).join('\n\n');
    const files = parts
        .filter((part) => part?.type === 'file' && part.url)
        .map((part) => {
            // The gateway inlines every attachment. Anything else would be resolved by OpenCode itself.
            if (!String(part.url).startsWith('data:')) throw new Error('Attachments must be inlined as data: URIs');
            return { uri: part.url, ...(part.filename ? { name: part.filename } : {}) };
        });
    return { text, files };
}

/** OpenCode 2 has no per-prompt output format, so the requirement goes into the instructions. */
function formatInstruction(format) {
    if (!format) return '';
    return format.type === 'json_schema'
        ? `Reply with only JSON matching this schema: ${JSON.stringify(format.schema)}`
        : 'Reply with only a valid JSON object.';
}

/**
 * Client for the `opencode serve` API of OpenCode 2 (everything under /api).
 * It offers the same interface as the OpenCode 1 client in client.js and
 * returns OpenCode 1 shaped data, so the rest of the gateway does not care
 * which generation it talks to.
 *
 * Differences it absorbs:
 * - a prompt is queued and returns at once, so the client waits for the
 *   session to go idle and then reads the turn back;
 * - model, agent and system prompt are session state, set before each prompt;
 * - requests are answered per session, not by id alone.
 *
 * @param {{ baseUrl: string, username?: string, password?: string, fetchImpl?: typeof fetch }} options
 */
export function createOpencodeClientV2(options) {
    const chatOnly = options.profile === 'chat';
    const { base, request, openStream } = createHttp(options);
    const id = (value) => encodeURIComponent(value);
    let agentsCache = null;
    async function verifyChatProfile(signal) {
        let plugins = (await call('GET', '/api/plugin', { signal }))?.data;
        if (Array.isArray(plugins) && plugins.length === 0) {
            await call('GET', '/api/model', { signal });
            plugins = (await call('GET', '/api/plugin', { signal }))?.data;
        }
        if (!Array.isArray(plugins) || !plugins.some((plugin) => plugin.id === CHAT_PLUGIN_ID && plugin.state?.status === 'active' && plugin.source?.type === 'local')) {
            throw new ApiError(503, 'The strict chat profile is unavailable; no prompt was submitted.', { code: 'backend_chat_profile_unavailable' });
        }
    }

    /**
     * OpenCode 2 answers paths outside /api with its web app (HTTP 200, HTML),
     * which would pass for an empty success. Every real reply is JSON.
     */
    async function call(method, path, requestOptions) {
        const body = await request(method, path, requestOptions);
        if (typeof body === 'string') throw new BackendError(`OpenCode ${method} ${path} did not answer with JSON`);
        return body;
    }

    /** Names of the agents the server knows, cached briefly (the list is static for a server). */
    async function knownAgents(signal) {
        if (agentsCache && Date.now() - agentsCache.at < AGENTS_CACHE_MS) return agentsCache.names;
        let agents = (await call('GET', '/api/agent', { signal }))?.data;
        // V2 loads agent plugins lazily. A new server can list no agents until
        // the model catalog has initialized its location; never cache that state.
        if (Array.isArray(agents) && agents.length === 0) {
            await call('GET', '/api/model', { signal });
            agents = (await call('GET', '/api/agent', { signal }))?.data;
        }
        if (!Array.isArray(agents)) throw new BackendError('OpenCode did not return an agent list');
        const names = new Set(agents.filter((agent) => agent && agent.mode !== 'subagent' && agent.hidden !== true)
            .map((agent) => agent.id || agent.name));
        agentsCache = { at: Date.now(), names };
        return names;
    }

    /** Messages of a session, oldest first. */
    async function listMessages(sessionId, { signal, order = 'asc', limit = MESSAGE_PAGE } = {}) {
        const items = [];
        const seen = new Set();
        let cursor = null;
        for (let page = 0; page < MAX_PAGES; page += 1) {
            // The cursor carries the order; the server rejects the two together.
            const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : { order }) });
            const body = await call('GET', `/api/session/${id(sessionId)}/message?${query}`, { signal });
            const batch = (body?.data || []).filter((item) => item?.id && !seen.has(item.id));
            for (const item of batch) seen.add(item.id);
            items.push(...batch);
            cursor = body?.cursor?.next;
            if (!cursor || batch.length < limit) break;
        }
        return items;
    }

    /**
     * Applies the agent, model and system prompt a v1 prompt body carries.
     * @returns the system text when it is too large for an instruction entry, to be sent with the prompt instead
     */
    async function prepare(sessionId, body, signal) {
        // An agent can carry its own model, so it is selected before the model is.
        if (body.agent) {
            if (!(await knownAgents(signal)).has(body.agent)) {
                throw new ApiError(503, 'The configured OPENCODE_AGENT is unavailable or incompatible with this backend.', { code: 'backend_agent_unavailable' });
            }
            await call('POST', `/api/session/${id(sessionId)}/agent`, { body: { agent: body.agent }, signal });
        }
        const { providerID, modelID } = body.model || {};
        const system = [body.system, formatInstruction(body.format)].filter(Boolean).join('\n\n');
        const oversized = system && Buffer.byteLength(JSON.stringify(system)) > MAX_INSTRUCTION_BYTES;
        await Promise.all([
            providerID && modelID && call('POST', `/api/session/${id(sessionId)}/model`, {
                body: { model: { providerID, id: modelID, ...(body.variant ? { variant: body.variant } : {}) } },
                signal,
            }),
            system && !oversized && call('PUT', `/api/experimental/session/${id(sessionId)}/instructions/entries/${SYSTEM_ENTRY}`, { body: { value: system }, signal }),
        ]);
        return oversized ? system : '';
    }

    /** Blocks until the queued prompt has finished; returns the messages after it, oldest first, and the closing idle marker. */
    async function settle(sessionId, userId, signal) {
        try {
            await request('POST', `/api/experimental/session/${id(sessionId)}/wait`, { timeoutMs: 0, signal });
        } catch (error) {
            // The wait route is experimental: without it, polling below is enough.
            if (!(error instanceof BackendError)) throw error;
        }
        for (;;) {
            const messages = await listMessages(sessionId, { signal });
            const sent = messages.findIndex((message) => message.id === userId);
            const turn = sent < 0 ? [] : messages.slice(sent + 1);
            const idle = turn.findLast((message) => message.type === 'idle');
            if (idle) return { turn, idle };
            await sleep(POLL_MS, signal);
        }
    }

    return Object.freeze({
        api: 'v2',
        baseUrl: base,
        async health(requestOptions) {
            const info = await call('GET', '/api/info', { timeoutMs: 3000, ...requestOptions });
            const healthy = typeof info?.version === 'string' && Array.isArray(info?.urls);
            return { healthy, version: healthy ? info.version : undefined };
        },
        async providers(requestOptions) {
            return providersFromModels((await call('GET', '/api/model', requestOptions))?.data);
        },
        async agents(requestOptions) {
            return (await call('GET', '/api/agent', requestOptions))?.data || [];
        },
        async createSession(requestOptions) {
            // The tools stay offered to the model exactly as in stock OpenCode: denying them
            // all changes the request in a way Zen's free tier refuses.
            const created = await call('POST', '/api/session', {
                body: { title: 'openai-gateway', permissions: chatOnly ? [{ action: '*', resource: '*', effect: 'deny' }] : SESSION_PERMISSIONS },
                ...requestOptions,
            });
            return { id: created?.data?.id };
        },
        deleteSession: (sessionId, requestOptions) => call('DELETE', `/api/session/${id(sessionId)}`, requestOptions),
        abortSession: (sessionId, requestOptions) => call('POST', `/api/session/${id(sessionId)}/interrupt`, { timeoutMs: 5000, ...requestOptions }),
        async messages(sessionId, requestOptions) {
            return (await listMessages(sessionId, requestOptions)).map((message) => messageFromV2(message, sessionId)).filter(Boolean);
        },
        async message(sessionId, messageId, requestOptions) {
            const body = await call('GET', `/api/session/${id(sessionId)}/message/${id(messageId)}`, requestOptions);
            return messageFromV2(body?.data, sessionId);
        },
        /** Runs one turn to completion; returns the final assistant message as `{ info, parts }`. */
        async prompt(sessionId, body, requestOptions = {}) {
            const { signal } = requestOptions;
            const { text, files } = splitParts(body.parts);
            if (chatOnly) {
                if (files.length) throw new ApiError(400, 'The strict chat profile currently supports text inputs only.', { code: 'unsupported_modality', param: 'messages' });
                if (body.agent !== CHAT_AGENT) throw new ApiError(503, 'Strict chat requires the dedicated conversational agent.', { code: 'backend_agent_unavailable' });
                await verifyChatProfile(signal);
            }
            const overflow = await prepare(sessionId, chatOnly ? { ...body, system: undefined, format: undefined } : body, signal);
            const queued = await call('POST', `/api/session/${id(sessionId)}/prompt`, {
                body: { text: overflow ? `${overflow}\n\n${text}` : text, ...(files.length ? { files } : {}),
                    ...(chatOnly ? { metadata: { zengateChat: { version: 1, system: [body.system, formatInstruction(body.format)].filter(Boolean).join('\n\n') } } } : {}) },
                signal,
            });
            if (!queued?.data?.id) throw new BackendError('OpenCode did not return a message id for the prompt');
            const { turn, idle } = await settle(sessionId, queued.data.id, signal);
            const assistant = turn.findLast((message) => message.type === 'assistant');
            const broken = idle.outcome === 'failed' || idle.outcome === 'interrupted';
            if (assistant && (!broken || assistant.error)) return messageFromV2(assistant, sessionId);
            const reason = idle.outcome === 'interrupted' ? 'The OpenCode turn was interrupted.' : 'The OpenCode turn failed before the model answered.';
            return {
                info: { id: assistant?.id ?? idle.id, sessionID: sessionId, role: 'assistant', error: { name: 'UnknownError', data: { message: reason } } },
                parts: [],
            };
        },
        replyPermission: (requestId, reply, message, sessionId) =>
            call('POST', `/api/session/${id(sessionId)}/permission/${id(requestId)}/reply`, {
                body: { decision: reply, ...(message ? { message } : {}) },
                timeoutMs: 5000,
            }),
        rejectQuestion: (requestId, sessionId) => call('DELETE', `/api/session/${id(sessionId)}/form/${id(requestId)}`, { timeoutMs: 5000 }),
        async pendingPermissions() {
            return (await call('GET', '/api/permission/request', { timeoutMs: 5000 }))?.data || [];
        },
        async pendingQuestions() {
            return (await call('GET', '/api/form', { timeoutMs: 5000 }))?.data || [];
        },
        openEvents: (signal) => openStream('/api/event', signal),
        adaptEvent,
        verifyChatProfile,
    });
}
