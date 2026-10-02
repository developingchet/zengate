import { invalidRequest } from '../server/errors.js';

/**
 * OpenCode cannot pass a token limit to the model, so `max_tokens` is applied
 * to the streamed answer instead. Tokens are not counted exactly: a token is
 * taken to be about four characters, which is close for English text.
 */
export const CHARS_PER_TOKEN = 4;
const MAX_TOKENS = 1_000_000;

/**
 * The first of `names` that `body` sets, as a validated token count, or null.
 * @param {object} body request body
 * @param {string[]} names parameter names in order of precedence
 */
export function parseMaxTokens(body, names) {
    const name = names.find((key) => body[key] !== undefined && body[key] !== null);
    if (!name) return null;
    const value = body[name];
    if (!Number.isInteger(value) || value < 1 || value > MAX_TOKENS) {
        throw invalidRequest(`${name} must be an integer from 1 to ${MAX_TOKENS}.`, name);
    }
    return value;
}

/**
 * Cuts streamed text once `maxChars` characters have passed.
 * @param {number} maxChars Infinity for no limit
 */
export function createLengthLimit(maxChars) {
    let used = 0;
    let reached = false;
    return {
        get reached() { return reached; },
        get used() { return used; },
        /** @returns {string} the part of `text` that fits */
        push(text) {
            if (reached || !text) return '';
            const room = maxChars - used;
            if (text.length <= room) {
                used += text.length;
                return text;
            }
            reached = true;
            used = maxChars;
            return text.slice(0, room);
        },
    };
}
