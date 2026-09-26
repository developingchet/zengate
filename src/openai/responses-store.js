const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRY_CHARS = 4 * 1024 * 1024;

/**
 * In-memory store behind previous_response_id and GET/DELETE
 * /v1/responses/{id}. Bounded (LRU + 1h TTL) and never persisted: a gateway
 * restart forgets stored responses, which clients see as "not found".
 * @param {{ maxEntries: number }} options
 */
export function createResponsesStore({ maxEntries }) {
    const entries = new Map();
    const items = new Map();

    const expired = (entry) => Date.now() - entry.at > TTL_MS;

    function evict(id) {
        const entry = entries.get(id);
        if (!entry) return;
        for (const itemId of entry.itemIds) items.delete(itemId);
        entries.delete(id);
    }

    function get(id) {
        const entry = entries.get(id);
        if (!entry) return null;
        if (expired(entry)) {
            evict(id);
            return null;
        }
        entries.delete(id);
        entries.set(id, entry);
        return entry;
    }

    const owned = (id, owner) => {
        const entry = get(id);
        return entry && entry.owner === owner ? entry : null;
    };

    /**
     * A view limited to one client (API key): other keys' responses are
     * invisible, as if they did not exist.
     * @param {string} owner opaque client id
     */
    function scope(owner) {
        return Object.freeze({
            /**
             * @param {object} response public Response object
             * @param {object[]} history canonical messages up to and including this turn
             */
            save(response, history) {
                if (maxEntries <= 0) return;
                if (JSON.stringify(history).length > MAX_ENTRY_CHARS) return;
                const itemIds = response.output.map((item) => item.id);
                for (const item of response.output) items.set(item.id, { item, responseId: response.id });
                entries.set(response.id, { response, history, itemIds, owner, at: Date.now() });
                while (entries.size > maxEntries) evict(entries.keys().next().value);
            },
            response: (id) => owned(id, owner)?.response ?? null,
            history: (id) => owned(id, owner)?.history ?? null,
            item(id) {
                const found = items.get(id);
                return found && owned(found.responseId, owner) ? found.item : null;
            },
            delete(id) {
                if (!owned(id, owner)) return false;
                evict(id);
                return true;
            },
        });
    }

    return Object.freeze({
        enabled: maxEntries > 0,
        scope,
        size: () => entries.size,
    });
}
