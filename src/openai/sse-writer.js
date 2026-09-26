const HEARTBEAT_MS = 15000;

/**
 * Server-sent events response helper: flushes headers immediately, disables
 * Nagle for low token latency and sends comment heartbeats so idle proxies
 * don't cut long generations.
 */
export function openSse(res) {
    res.status(200);
    res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.socket?.setNoDelay(true);
    const heartbeat = setInterval(() => write(': keep-alive\n\n'), HEARTBEAT_MS);
    heartbeat.unref();

    function write(text) {
        if (res.writableEnded || res.destroyed) return;
        res.write(text);
    }

    return {
        /** Send one JSON event; `event` adds an SSE event name (Responses API). */
        send(data, event) {
            write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
        },
        raw: write,
        end() {
            clearInterval(heartbeat);
            if (!res.writableEnded) res.end();
        },
    };
}
