import { createOpencodeClient } from './client.js';
import { createOpencodeClientV2 } from './client-v2.js';

// OpenCode 1 first: its health route answers JSON only there (OpenCode 2 serves
// its web app on every unknown path), so a healthy reply identifies the generation.
const CLIENTS = [createOpencodeClient, createOpencodeClientV2];

/**
 * Find out which API generation the server at `options.baseUrl` speaks.
 * @param {Parameters<typeof createOpencodeClient>[0]} options
 * @returns {Promise<{ client: ReturnType<typeof createOpencodeClient>, health: { healthy: true, version?: string } } | null>}
 *   null when the server answers but reports neither generation healthy
 * @throws the first transport error when the server could not be reached
 */
export async function probeBackend(options) {
    let failure = null;
    for (const create of CLIENTS) {
        const client = create(options);
        try {
            const health = await client.health();
            if (health?.healthy === true) return { client, health };
        } catch (error) {
            failure ??= error;
        }
    }
    if (failure) throw failure;
    return null;
}
