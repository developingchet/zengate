import { CHARS_PER_TOKEN, createLengthLimit } from './length-limit.js';
import { createStopFilter } from './stop.js';
import { createToolCallParser } from './tool-calls.js';

const STOP_REACHED = Symbol('stop-sequence');
const LENGTH_REACHED = Symbol('max-tokens');
const SEPARATOR = '\n\n';

const FORCED_RETRY_NOTE = 'To call a function, write a <tool_call>{"name": ..., "arguments": {...}}</tool_call> block as plain text in your reply. Do not describe the call; write the block.';

const NO_USAGE = Object.freeze({ input: 0, output: 0, reasoning: 0, cacheRead: 0 });
const estimateTokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);

const addUsage = (a, b) => ({ input: a.input + b.input, output: a.output + b.output, reasoning: a.reasoning + b.reasoning, cacheRead: a.cacheRead + b.cacheRead });

/**
 * Run one completion through OpenCode and apply the OpenAI-side semantics:
 * stop sequences, max_tokens, emulated function calls and structured output.
 *
 * @param {{ runner: object, prompt: object, request: object, signal: AbortSignal, maxChars: number,
 *           onText?: (text: string) => void, onReasoning?: (text: string) => void }} options
 * @returns {Promise<{ content: string, reasoning: string, toolCalls: object[], finish: string, usage: object }>}
 */
async function attempt({ runner, prompt, request, signal, maxChars, onText, onReasoning }) {
    const controller = new AbortController();
    const forward = () => controller.abort(signal.reason);
    if (signal.aborted) forward();
    else signal.addEventListener('abort', forward, { once: true });

    const stopFilter = createStopFilter(request.stop);
    const lengthLimit = createLengthLimit(maxChars);
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
    const accept = (text) => {
        const allowed = lengthLimit.push(text);
        emitText(parser ? parser.push(allowed) : allowed);
    };
    const acceptText = (text) => {
        accept(stopFilter.push(text));
        if (controller.signal.aborted) return;
        if (stopFilter.stopped) controller.abort(STOP_REACHED);
        else if (lengthLimit.reached) controller.abort(LENGTH_REACHED);
    };
    const done = () => stopFilter.stopped || lengthLimit.reached;

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
                } else if (!done()) {
                    acceptText(text);
                }
            },
        });
    } catch (error) {
        const reason = controller.signal.reason;
        if (reason !== STOP_REACHED && reason !== LENGTH_REACHED) throw error;
    } finally {
        signal.removeEventListener('abort', forward);
    }

    if (result?.structured !== undefined) {
        acceptText(typeof result.structured === 'string' ? result.structured : JSON.stringify(result.structured));
    } else if (held) {
        acceptText(held);
    }
    accept(stopFilter.flush());
    let toolCalls = [];
    if (parser) {
        // A call cut off by max_tokens cannot be parsed, and its markup is not content.
        const truncatedCall = lengthLimit.reached && parser.capturing;
        const finished = parser.finish();
        toolCalls = finished.calls;
        if (!truncatedCall) emitText(finished.text);
    }
    let finish = result?.finish || 'stop';
    if (toolCalls.length) finish = 'tool_calls';
    else if (stopFilter.stopped) finish = 'stop';
    else if (lengthLimit.reached) finish = 'length';

    return {
        content,
        reasoning,
        toolCalls,
        finish,
        // A cut-off turn is aborted before OpenCode reports usage, so estimate the output side.
        usage: result?.usage || (done() ? { ...NO_USAGE, output: estimateTokens(content), reasoning: estimateTokens(reasoning) } : NO_USAGE),
        nativeToolAttempt: result?.nativeToolAttempt || null,
    };
}

/**
 * attempt() plus one corrective retry when the model tried to call a client
 * function as a native tool, or answered in prose although tool_choice
 * demands a call (weaker models occasionally do either).
 * @param {Parameters<typeof attempt>[0]} options
 */
export async function generate({ onText: textSink = () => {}, onReasoning: reasoningSink = () => {}, onFirstToken, ...options }) {
    const { request, prompt, signal } = options;
    const noticing = (sink) => (onFirstToken ? (text) => { if (text) onFirstToken(); sink(text); } : sink);
    const onText = noticing(textSink);
    const onReasoning = noticing(reasoningSink);
    const maxChars = request.maxTokens ? request.maxTokens * CHARS_PER_TOKEN : Infinity;
    const initial = await attempt({ ...options, maxChars, onText, onReasoning });
    const forced = request.toolChoice === 'required' || (request.toolChoice && typeof request.toolChoice === 'object');
    if (initial.toolCalls.length || initial.finish === 'length' || signal.aborted || !(forced || initial.nativeToolAttempt)) return initial;
    const hasClientTools = request.tools.length > 0 && request.toolChoice !== 'none';
    let note = FORCED_RETRY_NOTE;
    if (initial.nativeToolAttempt && hasClientTools) {
        note = `Your previous attempt to call "${initial.nativeToolAttempt}" as a native tool failed: client functions are not native tools. ${FORCED_RETRY_NOTE}`;
    } else if (initial.nativeToolAttempt) {
        note = `There is no tool named "${initial.nativeToolAttempt}". Answer directly without calling tools.`;
    }
    const retryPrompt = { ...prompt, system: [prompt.system, note].filter(Boolean).join(SEPARATOR) };
    let separated = false;
    const separate = (emit) => (text) => {
        if (initial.content && !separated && text) {
            separated = true;
            onText(SEPARATOR);
        }
        emit(text);
    };
    const remaining = Math.max(1, maxChars - initial.content.length - (initial.content ? SEPARATOR.length : 0));
    const second = await attempt({ ...options, maxChars: remaining, prompt: retryPrompt, onText: separate(onText), onReasoning });
    return {
        ...second,
        content: separated ? `${initial.content}${SEPARATOR}${second.content}` : initial.content + second.content,
        reasoning: initial.reasoning + second.reasoning,
        usage: addUsage(initial.usage, second.usage),
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
