/**
 * Applies OpenAI `stop` sequences to streamed text. Text that could be the
 * beginning of a stop sequence is held back until it is safe to release.
 * @param {string[]} stops
 */
export function createStopFilter(stops) {
    const sequences = stops.filter(Boolean);
    let pending = '';
    let stopped = false;

    /** Index of the earliest complete stop sequence in `pending`, or -1. */
    function firstMatch() {
        let cut = -1;
        for (const sequence of sequences) {
            const index = pending.indexOf(sequence);
            if (index >= 0 && (cut < 0 || index < cut)) cut = index;
        }
        return cut;
    }

    /**
     * Index of the earliest position where `pending` ends with the start of a
     * stop sequence that more text could complete, or `pending.length`.
     */
    function firstPartial() {
        for (let i = 0; i < pending.length; i++) {
            const tail = pending.slice(i);
            if (sequences.some((s) => s.length > tail.length && s.startsWith(tail))) return i;
        }
        return pending.length;
    }

    function stopAt(cut) {
        stopped = true;
        const out = pending.slice(0, cut);
        pending = '';
        return out;
    }

    return {
        get stopped() { return stopped; },
        /** @returns {string} text that can be emitted now */
        push(text) {
            if (stopped || !text) return '';
            if (!sequences.length) return text;
            pending += text;
            const cut = firstMatch();
            // A longer sequence that starts earlier may still complete, so a
            // match is final only when no partial one begins before it.
            const partial = firstPartial();
            if (cut >= 0 && cut <= partial) return stopAt(cut);
            const safe = cut >= 0 ? Math.min(cut, partial) : partial;
            const out = pending.slice(0, safe);
            pending = pending.slice(safe);
            return out;
        },
        flush() {
            if (stopped) return '';
            const cut = firstMatch();
            const out = cut >= 0 ? pending.slice(0, cut) : pending;
            pending = '';
            return out;
        },
    };
}
