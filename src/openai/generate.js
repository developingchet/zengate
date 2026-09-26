import { createStopFilter } from './stop.js';
import { createToolCallParser } from './tool-calls.js';

const STOP_REACHED = Symbol('stop-sequence');
const SEPARATOR = '\n\n';

const FORCED_RETRY_NOTE = 'To call a function, write a <tool_call>{"name": ..., "arguments": {...}}</tool_call> block as plain text in your reply. Do not describe the call; write the block.';

const addUsage = (a, b) => ({ input: a.input + b.input, output: a.output + b.output, reasoning: a.reasoning + b.reasoning, cacheRead: a.cacheRead + b.cacheRead });

/**
 * Run one completion through OpenCode and apply the OpenAI-side semantics:
 * stop sequences, emulated function calls and structured output.
 *
 * @param {{ runner: object, prompt: object, request: object, signal: AbortSignal,
 *           onText?: (text: string) => void, onReasoning?: (text: string) => void }} options
 * @returns {Promise<{ content: string, reasoning: string, toolCalls: object[], finish: string, usage: object }>}
 */
async function attempt({ runner, prompt, request, signal, onText, onReasoning }) {
    const controller = new AbortController();
    const forward = () => controller.abort(signal.reason);
    if (signal.aborted) forward();
    else signal.addEventListener('abort', forward, { once: true });

    const stopFilter = createStopFilter(request.stop);
    const parser = request.tools.length && request.toolChoice !== 'none' ? createToolCallParser(request.tools) : null;
    // With native structured output, OpenCode returns the JSON separately
    // (info.structured) and any streamed text may be prose, so hold it back.
    const nativeFormat = Boolean(prompt.format);
    let held = '';
    let content = '';
    let reasoning = '';

    const emitText = (text) => {
        if (!text) return;
        content += text;
        onText(text);
    };
    const acceptText = (text) => {
        const allowed = stopFilter.push(text);
        emitText(parser ? parser.push(allowed) : allowed);
        if (stopFilter.stopped && !controller.signal.aborted) controller.abort(STOP_REACHED);
    };

    let result = null;
    try {
        result = await runner.run(prompt, {
            signal: controller.signal,
            onDelta(kind, text) {
                if (kind === 'reasoning') {
                    reasoning += text;
                    onReasoning(text);
                } else if (nativeFormat) {
                    held += text;
                } else if (!stopFilter.stopped) {
                    acceptText(text);
                }
            },
        });
    } catch (error) {
        if (controller.signal.reason !== STOP_REACHED) throw error;
    } finally {
        signal.removeEventListener('abort', forward);
    }

    if (result?.structured !== undefined) {
        acceptText(typeof result.structured === 'string' ? result.structured : JSON.stringify(result.structured));
    } else if (held) {
        acceptText(held);
    }
    const tail = stopFilter.flush();
    emitText(parser ? parser.push(tail) : tail);
    let toolCalls = [];
    if (parser) {
        const finished = parser.finish();
        toolCalls = finished.calls;
        emitText(finished.text);
    }
    let finish = result?.finish || 'stop';
    if (toolCalls.length) finish = 'tool_calls';
    else if (stopFilter.stopped) finish = 'stop';

    return {
        content,
        reasoning,
        toolCalls,
        finish,
        usage: result?.usage || { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
        nativeToolAttempt: result?.nativeToolAttempt || null,
    };
}

/**
 * attempt() plus one corrective retry when the model tried to call a client
 * function as a native tool, or answered in prose although tool_choice
 * demands a call (weaker models occasionally do either).
 * @param {Parameters<typeof attempt>[0]} options
 */
export async function generate({ onText = () => {}, onReasoning = () => {}, ...options }) {
    const first = await attempt({ ...options, onText, onReasoning });
    const { request, prompt, signal } = options;
    const forced = request.toolChoice === 'required' || (request.toolChoice && typeof request.toolChoice === 'object');
    if (first.toolCalls.length || signal.aborted || !(forced || first.nativeToolAttempt)) return first;
    const hasClientTools = request.tools.length > 0 && request.toolChoice !== 'none';
    let note = FORCED_RETRY_NOTE;
    if (first.nativeToolAttempt && hasClientTools) {
        note = `Your previous attempt to call "${first.nativeToolAttempt}" as a native tool failed: client functions are not native tools. ${FORCED_RETRY_NOTE}`;
    } else if (first.nativeToolAttempt) {
        note = `There is no tool named "${first.nativeToolAttempt}". Answer directly without calling tools.`;
    }
    const retryPrompt = { ...prompt, system: [prompt.system, note].filter(Boolean).join(SEPARATOR) };
    let separated = false;
    const separate = (emit) => (text) => {
        if (first.content && !separated && text) {
            separated = true;
            onText(SEPARATOR);
        }
        emit(text);
    };
    const second = await attempt({ ...options, prompt: retryPrompt, onText: separate(onText), onReasoning });
    return {
        ...second,
        content: separated ? `${first.content}${SEPARATOR}${second.content}` : first.content + second.content,
        reasoning: first.reasoning + second.reasoning,
        usage: addUsage(first.usage, second.usage),
    };
}

/** OpenAI Chat Completions usage object. */
export function chatUsage(usages) {
    const total = usages.reduce((acc, u) => ({
        input: acc.input + u.input, output: acc.output + u.output, reasoning: acc.reasoning + u.reasoning, cacheRead: acc.cacheRead + u.cacheRead,
    }), { input: 0, output: 0, reasoning: 0, cacheRead: 0 });
    const prompt = total.input + total.cacheRead;
    const completion = total.output + total.reasoning;
    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        prompt_tokens_details: { cached_tokens: total.cacheRead },
        completion_tokens_details: { reasoning_tokens: total.reasoning },
    };
}
