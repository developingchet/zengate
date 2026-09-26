import { ApiError } from '../server/errors.js';

const CACHE_MS = 60000;
const MODALITIES = ['text', 'image', 'audio', 'video', 'pdf'];

/**
 * Model catalog read from the backend's /config/providers. Models from the
 * built-in `opencode` provider (keyless Zen) are exposed by their bare id;
 * any other provider the backend knows about is exposed as `provider/model`.
 */
export function createCatalog({ getClient, logger }) {
    let cache = null;
    let cachedAt = 0;
    let inflight = null;

    async function refresh() {
        const payload = await getClient().providers();
        const models = [];
        for (const provider of Array.isArray(payload?.providers) ? payload.providers : []) {
            for (const [key, raw] of Object.entries(provider?.models || {})) {
                const model = normalizeModel(provider.id, key, raw);
                if (model) models.push(model);
            }
        }
        models.sort((a, b) => a.id.localeCompare(b.id));
        cache = { list: models, byId: new Map(models.map((model) => [model.id, model])) };
        cachedAt = Date.now();
        return cache;
    }

    async function load() {
        if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
        inflight ??= refresh().finally(() => { inflight = null; });
        try {
            return await inflight;
        } catch (error) {
            if (cache) {
                logger.warn('Model catalog refresh failed; serving the cached list', { error: error.message });
                return cache;
            }
            throw new ApiError(503, 'The OpenCode backend is not ready yet; retry in a few seconds.', { code: 'backend_unavailable', retryAfter: 2 });
        }
    }

    return Object.freeze({
        list: async () => (await load()).list,
        /** Resolve a client model id (bare, `opencode/`-prefixed, or provider/model). */
        async resolve(requested) {
            const { byId, list } = await load();
            const id = String(requested || '').trim();
            const model = byId.get(id) || byId.get(id.replace(/^opencode\//, ''));
            if (model) return model;
            const hint = list.slice(0, 12).map((m) => m.id).join(', ');
            throw new ApiError(404, `The model '${id}' does not exist or is not available keylessly. Available: ${hint}${list.length > 12 ? ', ...' : ''} (see GET /v1/models).`, { param: 'model', code: 'model_not_found' });
        },
        invalidate() { cachedAt = 0; },
    });
}

function normalizeModel(providerId, key, raw) {
    if (!raw || typeof raw !== 'object' || !providerId) return null;
    const modelId = String(raw.id || key);
    if (raw.status === 'deprecated') return null;
    const input = raw.capabilities?.input || {};
    const created = Date.parse(raw.release_date || '');
    return Object.freeze({
        id: providerId === 'opencode' ? modelId : `${providerId}/${modelId}`,
        providerID: providerId,
        modelID: modelId,
        name: raw.name || modelId,
        created: Number.isFinite(created) ? Math.floor(created / 1000) : 0,
        input: Object.freeze(MODALITIES.filter((kind) => input[kind] === true || (kind === 'text' && input.text !== false))),
        reasoning: raw.capabilities?.reasoning === true,
        variants: Object.freeze(Object.keys(raw.variants || {})),
        contextWindow: raw.limit?.context ?? null,
        maxOutputTokens: raw.limit?.output ?? null,
    });
}

/** The public OpenAI model object. */
export function toOpenAIModel(model) {
    return { id: model.id, object: 'model', created: model.created, owned_by: model.providerID };
}
