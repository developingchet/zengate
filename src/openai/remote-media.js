import https from 'node:https';
import net from 'node:net';
import { ApiError, invalidRequest, unsupported } from '../server/errors.js';
import { fileBlock } from './markup.js';
import { mapLimited } from './map-limited.js';
import { kindForMime } from './media.js';
import { assertPublicUrls, isBlockedAddress, publicLookup, resolvePublic } from './url-guard.js';

const FETCH_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 3;
const PARALLEL_FETCHES = 4;
const GENERIC_MIME = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
// A private agent: the global one follows HTTPS_PROXY when NODE_USE_ENV_PROXY is
// set, and a proxy would resolve names itself and bypass publicLookup.
const DIRECT_AGENT = new https.Agent({ keepAlive: false });
const USER_AGENT = 'zengate (+https://github.com/developingchet/zengate)';

const attachmentError = (message) => invalidRequest(message, null, 'invalid_attachment_url');

/**
 * An attachment URL as it may appear in errors and logs: only its origin.
 * Signed URLs carry their token in the query string or in a path segment,
 * and some URLs carry credentials, so all of those are left out.
 */
export function shown(url) {
    try {
        const parsed = new URL(url);
        const bare = parsed.pathname === '/' && !parsed.search && !parsed.hash;
        return `${parsed.origin}/${bare ? '' : '…'}`;
    } catch {
        return '(invalid URL)';
    }
}

function normalizeMime(header) {
    const mime = String(header || '').split(';')[0].trim().toLowerCase();
    return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

const SIGNATURES = [
    { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
    { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
    { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
    { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
    { mime: 'video/webm', bytes: [0x1a, 0x45, 0xdf, 0xa3] },
];

/** The type of a common image, video or PDF file from its first bytes. */
function sniffMime(body) {
    const found = SIGNATURES.find(({ bytes }) => bytes.every((byte, index) => body[index] === byte));
    if (found) return found.mime;
    if (body.toString('latin1', 0, 4) === 'RIFF' && body.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
    if (body.toString('latin1', 4, 8) === 'ftyp') return 'video/mp4';
    return '';
}

/**
 * The attachment's real type: the server's Content-Type or, when the server
 * only says "binary", the file's signature or the type guessed from the URL.
 * It must be the kind the URL was sent as (image_url must be an image),
 * except that a file URL may turn out to be text, which is inlined.
 */
function checkedMime(header, guessed, url, body) {
    let mime = normalizeMime(header);
    if (GENERIC_MIME.has(mime)) mime = sniffMime(body) || (guessed.includes('*') ? '' : guessed);
    const kind = mime ? kindForMime(mime) : null;
    const expected = kindForMime(guessed.replaceAll('*', 'x'));
    if (!kind) throw unsupported(`Attachment ${shown(url)} has unsupported type '${mime || 'unknown'}'.`);
    if (mime === 'image/svg+xml') throw unsupported('SVG images are not supported; send PNG, JPEG, GIF or WebP.');
    const textFile = kind === 'text' && (expected === 'pdf' || expected === 'text');
    if (kind !== expected && !textFile) throw attachmentError(`Attachment ${shown(url)} is ${mime}, not ${expected}.`);
    return { mime, kind };
}

/**
 * Byte budget for one request's attachments: each is capped at MAX_MEDIA_MB
 * and together they are capped at MAX_BODY_MB, the same bounds that apply to
 * inline data URIs. Returns a per-attachment counter.
 */
function createBudget({ maxBytes, maxTotalBytes }) {
    let total = 0;
    const mb = (bytes) => (bytes / 1048576).toFixed(0);
    return (url) => {
        let used = 0;
        const check = (bytes) => {
            if (used + bytes > maxBytes) {
                throw invalidRequest(`Attachment ${shown(url)} is larger than ${mb(maxBytes)} MB (MAX_MEDIA_MB).`, null, 'attachment_too_large');
            }
            if (total + bytes > maxTotalBytes) {
                throw invalidRequest(`Attachments add up to more than ${mb(maxTotalBytes)} MB (MAX_BODY_MB).`, null, 'attachment_too_large');
            }
        };
        return {
            check,
            take(bytes) {
                check(bytes);
                used += bytes;
                total += bytes;
            },
        };
    };
}

function readBody(response, limit) {
    return new Promise((resolve, reject) => {
        const fail = (error) => {
            response.destroy();
            reject(error);
        };
        const declared = Number(response.headers['content-length']);
        try {
            if (declared > 0) limit.check(declared);
        } catch (error) {
            fail(error);
            return;
        }
        const chunks = [];
        let ended = false;
        response.on('data', (chunk) => {
            try {
                limit.take(chunk.length);
                chunks.push(chunk);
            } catch (error) {
                fail(error);
            }
        });
        response.once('end', () => {
            ended = true;
            resolve(Buffer.concat(chunks));
        });
        response.once('error', reject);
        response.once('close', () => {
            if (!ended) reject(new Error('connection closed before the attachment was complete'));
        });
    });
}

function requestOnce(url, { transport, lookup, signal }) {
    return new Promise((resolve, reject) => {
        const request = transport.request(url, {
            method: 'GET',
            agent: DIRECT_AGENT,
            lookup,
            signal,
            headers: { accept: '*/*', 'accept-encoding': 'identity', 'user-agent': USER_AGENT },
        });
        request.once('response', resolve);
        request.once('error', reject);
        request.end();
    });
}

/**
 * Download one https attachment. Each connection, including every redirect
 * hop, goes through publicLookup, so only public addresses are ever reached.
 * Node does not call `lookup` for an IP literal, so literals are checked here.
 */
async function download(url, { transport, lookup, isBlocked, signal, limit }) {
    let current = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        if (net.isIP(current.hostname.replace(/^\[|\]$/g, ''))) await resolvePublic(current.hostname, { isBlocked });
        const response = await requestOnce(current, { transport, lookup, signal });
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
            response.resume();
            const next = new URL(response.headers.location, current);
            if (next.protocol !== 'https:') throw attachmentError(`Attachment ${shown(url)} redirects to a non-https URL.`);
            current = next;
            continue;
        }
        if (status < 200 || status >= 300) {
            response.resume();
            throw attachmentError(`Attachment ${shown(url)} returned HTTP ${status}.`);
        }
        return { body: await readBody(response, limit), contentType: response.headers['content-type'] };
    }
    throw attachmentError(`Attachment ${shown(url)} redirects more than ${MAX_REDIRECTS} times.`);
}

async function inlinePart(part, options) {
    const { signal, budget } = options;
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    let result;
    try {
        result = await download(part.url, { ...options, signal: AbortSignal.any([signal, timeout]), limit: budget(part.url) });
    } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        if (error instanceof ApiError) throw error;
        if (timeout.aborted) throw attachmentError(`Fetching attachment ${shown(part.url)} took longer than ${FETCH_TIMEOUT_MS / 1000}s.`);
        throw attachmentError(`Could not fetch attachment ${shown(part.url)}: ${error.code || error.message}.`);
    }
    const { mime, kind } = checkedMime(result.contentType, part.mime, part.url, result.body);
    if (kind === 'text') return { type: 'text', text: fileBlock(part.filename, result.body.toString('utf8')) };
    return { ...part, mime, url: `data:${mime};base64,${result.body.toString('base64')}` };
}

/**
 * Replace https attachment URLs in an OpenCode prompt with data URIs (or
 * inlined text) fetched by the gateway, so OpenCode never fetches a
 * client-chosen URL itself: no redirects to internal hosts, no DNS
 * rebinding, and remote files obey the same size limits as inline ones.
 * Every host is checked before the first download starts. Callers run this
 * inside the request's slot, so the DNS lookups and downloads count against
 * MAX_CONCURRENT and stop when `signal` aborts (client disconnect or
 * REQUEST_TIMEOUT_MS).
 * @param {{ parts: object[] }} prompt from buildPrompt
 * @param {{ maxBytes: number, maxTotalBytes: number, signal: AbortSignal,
 *           transport?: { request: typeof https.request }, isBlocked?: (address: string) => boolean }} options
 * @returns {Promise<object>} the prompt with every https part inlined
 */
export async function inlineRemoteAttachments(prompt, { maxBytes, maxTotalBytes, signal, transport = https, isBlocked = isBlockedAddress }) {
    const remote = prompt.parts.filter((part) => typeof part.url === 'string' && part.url.startsWith('https:'));
    if (remote.length === 0) return prompt;
    await assertPublicUrls(remote, { isBlocked, signal });
    // One failed attachment fails the request, so the other downloads are cancelled too.
    const siblings = new AbortController();
    const downloads = AbortSignal.any([signal, siblings.signal]);
    const options = {
        transport, lookup: publicLookup({ isBlocked, signal: downloads }), isBlocked,
        signal: downloads,
        budget: createBudget({ maxBytes, maxTotalBytes }),
    };
    const fetched = await mapLimited(remote, PARALLEL_FETCHES, (part) => inlinePart(part, options), () => siblings.abort());
    const replacements = new Map(remote.map((part, index) => [part, fetched[index]]));
    return { ...prompt, parts: prompt.parts.map((part) => replacements.get(part) ?? part) };
}
