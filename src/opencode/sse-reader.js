const MAX_FRAME_CHARS = 16 * 1024 * 1024;

/**
 * Parse a server-sent-events byte stream into { event, data } frames.
 * Handles CRLF/LF, multi-line data and chunk boundaries anywhere.
 * @param {AsyncIterable<Uint8Array>} body
 */
export async function* readSseFrames(body) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.length > MAX_FRAME_CHARS) throw new Error('SSE frame exceeds size limit');
        let boundary;
        while ((boundary = findBoundary(buffer)) !== null) {
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary.length);
            const parsed = parseFrame(frame);
            if (parsed) yield parsed;
        }
    }
    buffer += decoder.decode();
    const tail = parseFrame(buffer);
    if (tail) yield tail;
}

function findBoundary(buffer) {
    const match = /\r?\n\r?\n/.exec(buffer);
    return match ? { index: match.index, length: match[0].length } : null;
}

function parseFrame(frame) {
    let event = '';
    const data = [];
    for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('data:')) data.push(line.slice(line[5] === ' ' ? 6 : 5));
        else if (line.startsWith('event:')) event = line.slice(6).trim();
    }
    return data.length ? { event, data: data.join('\n') } : null;
}
