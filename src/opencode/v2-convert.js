/**
 * Translation between the OpenCode 2 API and the OpenCode 1 shapes the rest
 * of the gateway consumes (model catalog entries, assistant messages, errors
 * and server-sent events). Keeping the translation in one place lets the
 * runner, event hub and catalog stay independent of the API generation.
 */

const MODALITIES = ['text', 'image', 'audio', 'video', 'pdf'];

/** Models from GET /api/model as the `{ providers: [...] }` payload of OpenCode 1. */
export function providersFromModels(models) {
    const providers = new Map();
    for (const model of Array.isArray(models) ? models : []) {
        if (!model?.providerID || !model.modelID || model.enabled === false) continue;
        const input = new Set(model.capabilities?.input || ['text']);
        const released = model.time?.released;
        const raw = {
            id: model.modelID,
            name: model.name || model.modelID,
            status: model.status,
            release_date: Number.isFinite(released) ? new Date(released).toISOString() : undefined,
            capabilities: {
                input: Object.fromEntries(MODALITIES.map((kind) => [kind, input.has(kind)])),
                reasoning: Boolean(model.compatibility?.reasoningField) || (model.variants || []).length > 0,
            },
            variants: Object.fromEntries((model.variants || []).map((variant) => [variant.id, {}])),
            limit: model.limit || {},
        };
        const entry = providers.get(model.providerID) || { id: model.providerID, models: {} };
        entry.models[model.modelID] = raw;
        providers.set(model.providerID, entry);
    }
    return { providers: [...providers.values()] };
}

/**
 * OpenCode 2 reports a failed turn as { type, message, status? }. Map it to
 * the { name, data } error objects of OpenCode 1 that model-errors.js reads.
 */
export function errorFromV2(error) {
    if (!error) return undefined;
    const type = String(error.type || '');
    const data = { message: String(error.message || ''), ...(Number.isInteger(error.status) ? { statusCode: error.status } : {}) };
    if (type) data.type = type;
    for (const key of ['retryAfterMs', 'responseHeaders', 'resetAt']) {
        if (error[key] !== undefined) data[key] = error[key];
    }
    const is = (pattern) => pattern.test(type);
    let name = 'UnknownError';
    if (is(/auth/i)) name = 'ProviderAuthError';
    else if (is(/overflow|context/i)) name = 'ContextOverflowError';
    else if (is(/output.?length|max.?tokens/i)) name = 'MessageOutputLengthError';
    else if (is(/abort|interrupt|cancel/i)) name = 'MessageAbortedError';
    else if (is(/content.?filter/i)) name = 'ContentFilterError';
    else if (is(/structured/i)) name = 'StructuredOutputError';
    else if (data.statusCode || type === 'provider.free-limit' || type === 'provider.quota') name = 'APIError';
    return { name, data };
}

/** An OpenCode 2 session message as an OpenCode 1 `{ info, parts }`. */
export function messageFromV2(message, sessionId) {
    if (message?.type === 'assistant') {
        return {
            info: {
                id: message.id,
                sessionID: sessionId,
                role: 'assistant',
                tokens: message.tokens || {},
                finish: message.finish,
                ...(message.error ? { error: errorFromV2(message.error) } : {}),
            },
            parts: (message.content || [])
                .filter((part) => part?.type === 'text' || part?.type === 'reasoning')
                .map((part) => ({ type: part.type, text: part.text || '' })),
        };
    }
    if (message?.type === 'user') {
        return { info: { id: message.id, sessionID: sessionId, role: 'user' }, parts: [{ type: 'text', text: message.text || '' }] };
    }
    return null;
}

/** A text or reasoning delta: the part is announced first, since the stream has no reliable start event to rely on. */
function textDelta(data, kind) {
    if (typeof data.delta !== 'string') return [];
    const partID = `${data.assistantMessageID}:${kind}:${data.ordinal ?? 0}`;
    return [
        { type: 'message.part.updated', properties: { part: { id: partID, type: kind, sessionID: data.sessionID, messageID: data.assistantMessageID } } },
        { type: 'message.part.delta', properties: { sessionID: data.sessionID, messageID: data.assistantMessageID, partID, field: 'text', delta: data.delta } },
    ];
}

/**
 * Translate one OpenCode 2 stream event to zero or more OpenCode 1 events
 * ({ type, properties }). It keeps no state, so a dropped or reordered event
 * cannot leave anything behind. Requests without a session are dropped: they
 * cannot be answered, and the turn they block stops at the request timeout.
 * @returns {object[]}
 */
export function adaptEvent(event) {
    const data = event?.data || {};
    switch (event?.type) {
        case 'session.created':
            return [{ type: 'session.created', properties: { info: { id: data.sessionID, parentID: data.parentID } } }];
        case 'session.step.started':
            return [{ type: 'message.updated', properties: { info: { id: data.assistantMessageID, sessionID: data.sessionID, role: 'assistant' } } }];
        case 'session.text.delta':
            return textDelta(data, 'text');
        case 'session.reasoning.delta':
            return textDelta(data, 'reasoning');
        case 'session.tool.input.started':
            return [{
                type: 'message.part.updated',
                properties: { part: { id: data.id, type: 'tool', tool: data.name, sessionID: data.sessionID, messageID: data.assistantMessageID } },
            }];
        case 'session.retry.scheduled':
            return [{
                type: 'session.status',
                properties: { sessionID: data.sessionID, status: { type: 'retry', attempt: data.attempt, message: data.error?.message, ...(data.error ? { error: errorFromV2(data.error) } : {}) } },
            }];
        case 'permission.asked':
            return data.id && data.sessionID ? [{ type: 'permission.asked', properties: { id: data.id, sessionID: data.sessionID } }] : [];
        case 'form.created':
            return data.form?.id && data.form.sessionID
                ? [{ type: 'question.asked', properties: { id: data.form.id, sessionID: data.form.sessionID } }]
                : [];
        default:
            return [];
    }
}
