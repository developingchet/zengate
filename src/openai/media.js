import { invalidRequest, unsupported } from '../server/errors.js';

/**
 * Canonical media attachment:
 * { kind: 'image'|'audio'|'video'|'pdf'|'text', mime, url, filename?, text? }
 * `url` is a data: URI or an https URL; `text` holds decoded text files,
 * which are inlined into the prompt rather than attached.
 */

const AUDIO_MIME = Object.freeze({
    wav: 'audio/wav', mp3: 'audio/mpeg', mpeg: 'audio/mpeg', ogg: 'audio/ogg', flac: 'audio/flac',
    m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/opus', webm: 'audio/webm', pcm16: 'audio/L16',
});
const EXTENSION_MIME = Object.freeze({
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
    xml: 'application/xml', html: 'text/html', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
});
const TEXT_MIME = /^(text\/[\w.+-]+|application\/(json|xml|x-yaml|yaml|javascript|x-sh))$/;
const DATA_URI = /^data:([\w.+-]+\/[\w.+-]+)(?:;[\w.+-]+=[\w.+-]+)*;base64,([A-Za-z0-9+/_-]*={0,2})$/;
const MAX_URL_CHARS = 8192;

export function kindForMime(mime) {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    if (mime === 'application/pdf') return 'pdf';
    if (TEXT_MIME.test(mime)) return 'text';
    return null;
}

function checkSize(base64, maxBytes, param) {
    const bytes = Math.floor((base64.length * 3) / 4);
    if (bytes > maxBytes) {
        throw invalidRequest(`Attachment is ${(bytes / 1048576).toFixed(1)} MB; the limit is ${(maxBytes / 1048576).toFixed(0)} MB per part (MAX_MEDIA_MB).`, param, 'attachment_too_large');
    }
}

function fromDataUri(uri, { maxBytes, param, filename, expect }) {
    const match = DATA_URI.exec(uri);
    if (!match) throw invalidRequest('Attachments must be base64 data URIs (data:<mime>;base64,...) or https URLs.', param);
    const mime = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
    const kind = kindForMime(mime);
    if (!kind) throw unsupported(`Unsupported attachment type '${mime}'.`, param);
    if (expect && kind !== expect) throw invalidRequest(`Expected ${expect} data but received '${mime}'.`, param);
    if (mime === 'image/svg+xml') throw unsupported('SVG images are not supported; send PNG, JPEG, GIF or WebP.', param);
    checkSize(match[2], maxBytes, param);
    if (kind === 'text') {
        return { kind, mime, filename, text: Buffer.from(match[2], 'base64').toString('utf8') };
    }
    return { kind, mime, url: uri, filename };
}

function fromHttpsUrl(url, { param, kind, mime, filename }) {
    if (url.length > MAX_URL_CHARS) throw invalidRequest(`URL is longer than ${MAX_URL_CHARS} characters.`, param);
    let parsed;
    try { parsed = new URL(url); } catch { throw invalidRequest('Invalid attachment URL.', param); }
    if (parsed.protocol !== 'https:') throw invalidRequest('Attachment URLs must use https (or send a base64 data URI).', param);
    return { kind, mime, url: parsed.href, filename };
}

function urlPath(url) {
    try { return new URL(url).pathname; } catch { return ''; }
}

function guessMime(filename, fallback) {
    const ext = String(filename || '').toLowerCase().split('.').pop();
    return EXTENSION_MIME[ext] || fallback;
}

export function imageFromUrl(url, options) {
    if (typeof url !== 'string' || !url) throw invalidRequest('image_url.url is required.', options.param);
    if (url.startsWith('data:')) return fromDataUri(url, { ...options, expect: 'image' });
    return fromHttpsUrl(url, { ...options, kind: 'image', mime: guessMime(urlPath(url), 'image/*') });
}

export function videoFromUrl(url, options) {
    if (typeof url !== 'string' || !url) throw invalidRequest('video_url.url is required.', options.param);
    if (url.startsWith('data:')) return fromDataUri(url, { ...options, expect: 'video' });
    return fromHttpsUrl(url, { ...options, kind: 'video', mime: guessMime(urlPath(url), 'video/*') });
}

export function audioFromBase64(data, format, options) {
    const mime = AUDIO_MIME[String(format || '').toLowerCase()];
    if (!mime) throw invalidRequest(`input_audio.format must be one of: ${Object.keys(AUDIO_MIME).join(', ')}.`, options.param);
    if (typeof data !== 'string' || !data) throw invalidRequest('input_audio.data (base64) is required.', options.param);
    if (data.startsWith('data:')) return fromDataUri(data, { ...options, expect: 'audio' });
    return fromDataUri(`data:${mime};base64,${data}`, { ...options, expect: 'audio' });
}

/** OpenAI `file` parts: file_data (data URI or bare base64), or file_url. */
export function fileAttachment({ file_data: fileData, file_id: fileId, file_url: fileUrl, filename }, options) {
    const name = typeof filename === 'string' ? filename.slice(0, 255) : undefined;
    if (fileId) throw unsupported('file_id requires the Files API, which this gateway does not provide; send file_data instead.', options.param);
    if (typeof fileUrl === 'string' && fileUrl) {
        const mime = guessMime(urlPath(fileUrl), 'application/pdf');
        return fromHttpsUrl(fileUrl, { ...options, kind: kindForMime(mime) || 'pdf', mime, filename: name });
    }
    if (typeof fileData !== 'string' || !fileData) throw invalidRequest('file.file_data is required.', options.param);
    if (fileData.startsWith('data:')) return fromDataUri(fileData, { ...options, filename: name });
    const mime = guessMime(name, null);
    if (!mime) throw invalidRequest('Send file_data as a data URI (data:<mime>;base64,...) or include a filename with an extension.', options.param);
    return fromDataUri(`data:${mime};base64,${fileData}`, { ...options, filename: name });
}
