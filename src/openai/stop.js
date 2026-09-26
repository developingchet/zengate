/**
 * Applies OpenAI `stop` sequences to streamed text. Text that could be the
 * beginning of a stop sequence is held back until it is safe to release.
 * @param {string[]} stops
 */
export function createStopFilter(stops) {
    const sequences = stops.filter(Boolean);
    const hold = sequences.reduce((max, s) => Math.max(max, s.length - 1), 0);
    let pending = '';
    let stopped = false;

    return {
        get stopped() { return stopped; },
        /** @returns {string} text that can be emitted now */
        push(text) {
            if (stopped || !text) return '';
            if (!sequences.length) return text;
            pending += text;
            let cut = -1;
            for (const sequence of sequences) {
                const index = pending.indexOf(sequence);
                if (index >= 0 && (cut < 0 || index < cut)) cut = index;
            }
            if (cut >= 0) {
                stopped = true;
                const out = pending.slice(0, cut);
                pending = '';
                return out;
            }
            const safe = Math.max(0, pending.length - hold);
            const out = pending.slice(0, safe);
            pending = pending.slice(safe);
            return out;
        },
        flush() {
            const out = stopped ? '' : pending;
            pending = '';
            return out;
        },
    };
}
