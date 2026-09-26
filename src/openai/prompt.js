import { invalidRequest } from '../server/errors.js';
import { renderToolCall, toolInstructions } from './tool-calls.js';

const TRANSCRIPT_INTRO = 'The conversation so far is below, oldest first. Write only the next assistant reply — no role tags, no transcript markup.';

function attachmentLabel(media, index) {
    return `[attachment ${index + 1}: ${media.kind}${media.filename ? ` "${media.filename}"` : ''}]`;
}

function toolNameFor(messages, callId) {
    for (const message of messages) {
        const call = message.toolCalls?.find((c) => c.id === callId);
        if (call) return call.name;
    }
    return null;
}

/** Render a multi-turn conversation as one transcript with attachment markers. */
function renderTranscript(messages, attachments) {
    const blocks = [TRANSCRIPT_INTRO];
    for (const message of messages) {
        const labels = message.media.map((media) => {
            attachments.push(media);
            return attachmentLabel(media, attachments.length - 1);
        });
        const body = [message.content, ...labels].filter(Boolean).join('\n');
        if (message.role === 'tool') {
            const name = message.name || toolNameFor(messages, message.toolCallId) || 'function';
            blocks.push(`<tool_result name="${name}" call_id="${message.toolCallId}">\n${body}\n</tool_result>`);
        } else if (message.role === 'assistant') {
            const calls = (message.toolCalls || []).map(renderToolCall);
            blocks.push(`<assistant>\n${[body, ...calls].filter(Boolean).join('\n')}\n</assistant>`);
        } else {
            blocks.push(`<user>\n${body}\n</user>`);
        }
    }
    return blocks.join('\n\n');
}

function assertModalities(model, media) {
    for (const item of media) {
        if (!model.input.includes(item.kind)) {
            throw invalidRequest(`The model '${model.id}' does not accept ${item.kind} input (it accepts: ${model.input.join(', ')}). Pick a model from GET /v1/models that supports it.`, 'messages', 'unsupported_modality');
        }
    }
}

function pickVariant(model, effort) {
    if (!effort || effort === 'none') return undefined;
    return model.variants.includes(effort) ? effort : undefined;
}

/**
 * Translate a canonical request into an OpenCode prompt:
 * { model, system, parts, variant, format }.
 * @param {ReturnType<typeof import('./chat-request.js').parseChatRequest>} request
 * @param {object} model catalog entry
 */
export function buildPrompt(request, model) {
    const systemTexts = request.messages.filter((m) => m.role === 'system').map((m) => m.content).filter(Boolean);
    const turns = request.messages.filter((m) => m.role !== 'system');
    if (turns.length === 0) throw invalidRequest('messages must include at least one user message.', 'messages');

    const useNativeFormat = request.format && (request.tools.length === 0 || request.toolChoice === 'none');
    const tools = toolInstructions(request.tools, request.toolChoice, request.parallelToolCalls);
    if (tools) systemTexts.push(tools);
    if (request.format && !useNativeFormat) {
        systemTexts.push(request.format.type === 'json_schema'
            ? `When you answer without calling a function, reply with only JSON matching this schema: ${JSON.stringify(request.format.schema)}`
            : 'When you answer without calling a function, reply with only a valid JSON object.');
    }

    const attachments = [];
    let text;
    const single = turns.length === 1 && turns[0].role === 'user';
    if (single) {
        text = turns[0].content;
        attachments.push(...turns[0].media);
    } else {
        text = renderTranscript(turns, attachments);
    }
    assertModalities(model, attachments);

    const parts = [];
    if (text || attachments.length === 0) parts.push({ type: 'text', text: text || ' ' });
    attachments.forEach((media, index) => {
        parts.push({ type: 'file', mime: media.mime, url: media.url, filename: media.filename || `attachment-${index + 1}` });
    });

    return {
        model: { providerID: model.providerID, modelID: model.modelID },
        system: systemTexts.join('\n\n') || undefined,
        parts,
        variant: pickVariant(model, request.reasoningEffort),
        format: useNativeFormat
            ? { type: 'json_schema', schema: request.format.type === 'json_schema' ? request.format.schema : { type: 'object' } }
            : undefined,
        // Not sent to OpenCode: lets the runner spot native attempts at client functions.
        clientTools: tools ? request.tools.map((tool) => tool.name) : [],
    };
}
