import crypto from 'node:crypto';
import { toApiError } from '../server/errors.js';

const rid = (prefix) => `${prefix}_${crypto.randomBytes(16).toString('hex')}`;

export function responsesUsage(usage) {
    const input = usage.input + usage.cacheRead;
    const output = usage.output + usage.reasoning;
    return {
        input_tokens: input,
        input_tokens_details: { cached_tokens: usage.cacheRead },
        output_tokens: output,
        output_tokens_details: { reasoning_tokens: usage.reasoning },
        total_tokens: input + output,
    };
}

function callItem(call) {
    if (call.kind === 'custom') {
        let input = '';
        try { input = String(JSON.parse(call.arguments).input ?? ''); } catch { input = call.arguments; }
        return { id: rid('ctc'), type: 'custom_tool_call', status: 'completed', call_id: call.id, name: call.name, input };
    }
    return { id: rid('fc'), type: 'function_call', status: 'completed', call_id: call.id, name: call.name, arguments: call.arguments };
}

/**
 * Builds a Responses API object and (optionally) its streaming events in
 * the documented order: created → in_progress → output items with their
 * part/delta/done events → completed | incomplete | failed.
 * @param {{ model: string, echo: object, emit?: (event: object) => void }} options
 */
export function createResponseBuilder({ model, echo, emit = () => {} }) {
    const id = rid('resp');
    const createdAt = Math.floor(Date.now() / 1000);
    const output = [];
    let sequence = 0;
    let reasoning = null;
    let message = null;

    const send = (type, fields) => emit({ type, sequence_number: sequence++, ...fields });
    const snapshot = (status, extra = {}) => ({
        id, object: 'response', created_at: createdAt, status, background: false, error: null, incomplete_details: null,
        model, output: output.map((entry) => entry.item), usage: null, ...echo, ...extra,
    });
    const indexOf = (entry) => output.indexOf(entry);

    function openReasoning() {
        reasoning = { item: { id: rid('rs'), type: 'reasoning', summary: [] }, text: '' };
        output.push(reasoning);
        send('response.output_item.added', { output_index: indexOf(reasoning), item: { ...reasoning.item } });
        send('response.reasoning_summary_part.added', { item_id: reasoning.item.id, output_index: indexOf(reasoning), summary_index: 0, part: { type: 'summary_text', text: '' } });
    }

    function openMessage() {
        message = { item: { id: rid('msg'), type: 'message', status: 'in_progress', role: 'assistant', content: [] }, text: '' };
        output.push(message);
        send('response.output_item.added', { output_index: indexOf(message), item: { ...message.item } });
        send('response.content_part.added', { item_id: message.item.id, output_index: indexOf(message), content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } });
    }

    function closeReasoning() {
        if (!reasoning) return;
        const index = indexOf(reasoning);
        const part = { type: 'summary_text', text: reasoning.text };
        reasoning.item = { ...reasoning.item, summary: [part] };
        send('response.reasoning_summary_text.done', { item_id: reasoning.item.id, output_index: index, summary_index: 0, text: reasoning.text });
        send('response.reasoning_summary_part.done', { item_id: reasoning.item.id, output_index: index, summary_index: 0, part });
        send('response.output_item.done', { output_index: index, item: reasoning.item });
    }

    function closeMessage() {
        if (!message) return;
        const index = indexOf(message);
        const part = { type: 'output_text', text: message.text, annotations: [], logprobs: [] };
        message.item = { ...message.item, status: 'completed', content: [part] };
        send('response.output_text.done', { item_id: message.item.id, output_index: index, content_index: 0, text: message.text, logprobs: [] });
        send('response.content_part.done', { item_id: message.item.id, output_index: index, content_index: 0, part });
        send('response.output_item.done', { output_index: index, item: message.item });
    }

    function addCall(call) {
        const entry = { item: callItem(call) };
        output.push(entry);
        const index = indexOf(entry);
        const { item } = entry;
        if (item.type === 'custom_tool_call') {
            send('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress', input: '' } });
            send('response.custom_tool_call_input.delta', { item_id: item.id, output_index: index, delta: item.input });
            send('response.custom_tool_call_input.done', { item_id: item.id, output_index: index, input: item.input });
        } else {
            send('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress', arguments: '' } });
            send('response.function_call_arguments.delta', { item_id: item.id, output_index: index, delta: item.arguments });
            send('response.function_call_arguments.done', { item_id: item.id, output_index: index, name: item.name, arguments: item.arguments });
        }
        send('response.output_item.done', { output_index: index, item });
    }

    return {
        id,
        start() {
            send('response.created', { response: snapshot('in_progress') });
            send('response.in_progress', { response: snapshot('in_progress') });
        },
        reasoningDelta(text) {
            if (!reasoning) openReasoning();
            reasoning.text += text;
            send('response.reasoning_summary_text.delta', { item_id: reasoning.item.id, output_index: indexOf(reasoning), summary_index: 0, delta: text });
        },
        textDelta(text) {
            if (!message) openMessage();
            message.text += text;
            send('response.output_text.delta', { item_id: message.item.id, output_index: indexOf(message), content_index: 0, delta: text, logprobs: [] });
        },
        /** Close all items and emit the terminal event; returns the final Response. */
        finish(result) {
            closeReasoning();
            if (!message && result.toolCalls.length === 0) openMessage();
            closeMessage();
            result.toolCalls.forEach(addCall);
            const incomplete = result.finish === 'length' || result.finish === 'content_filter';
            const response = snapshot(incomplete ? 'incomplete' : 'completed', {
                incomplete_details: incomplete ? { reason: result.finish === 'length' ? 'max_output_tokens' : 'content_filter' } : null,
                usage: responsesUsage(result.usage),
            });
            send(incomplete ? 'response.incomplete' : 'response.completed', { response });
            return response;
        },
        fail(error) {
            const apiError = toApiError(error);
            send('response.failed', { response: snapshot('failed', { error: { code: apiError.code || 'server_error', message: apiError.message } }) });
            return apiError;
        },
    };
}
