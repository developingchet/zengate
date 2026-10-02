const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRY_CHARS = 4 * 1024 * 1024;

/**
 * In-memory store behind previous_response_id and GET/DELETE
 * /v1/responses/{id}. Bounded by entry count, by an approximate memory budget
 * (JSON size of each entry's full history, so chained turns that share
 * messages are counted conservatively) and by a 1h TTL, evicting least
 * recently used entries first. Never persisted: a gateway restart forgets
 * stored responses, which clients see as "not found".
 * @param {{ maxEntries: number, maxChars?: number }} options
 */
export function createResponsesStore({ maxEntries, maxChars = Infinity }) {
    const entries = new Map();
    const items = new Map();
    // Chained turns reuse the same message objects, so each is sized once.
    const messageSizes = new WeakMap();
    let chars = 0;

    const expired = (entry) => Date.now() - entry.at > TTL_MS;

    const messageSize = (message) => {
        let size = messageSizes.get(message);
        if (size === undefined) {
            size = JSON.stringify(message).length;
            messageSizes.set(message, size);
        }
        return size;
    };

    function evict(id) {
        const entry = entries.get(id);
        if (!entry) return;
        for (const itemId of entry.itemIds) items.delete(itemId);
        entries.delete(id);
        chars -= entry.size;
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
                const size = history.reduce((sum, message) => sum + messageSize(message), JSON.stringify(response).length);
                if (size > Math.min(MAX_ENTRY_CHARS, maxChars)) return;
                evict(response.id);
                const itemIds = response.output.map((item) => item.id);
                for (const item of response.output) items.set(item.id, { item, responseId: response.id });
                entries.set(response.id, { response, history, itemIds, owner, at: Date.now(), size });
                chars += size;
                while (entries.size > maxEntries || chars > maxChars) evict(entries.keys().next().value);
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
        chars: () => chars,
    });
}
