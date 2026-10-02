import { invalidRequest, unsupported } from '../server/errors.js';
import { parseResponseFormat, parseToolChoice } from './chat-request.js';
import { audioFromBase64, fileAttachment, imageFromUrl, videoFromUrl } from './media.js';
import { fileBlock } from './markup.js';

const IGNORED = new Set([
    'temperature', 'top_p', 'max_output_tokens', 'max_tool_calls', 'top_logprobs', 'truncation', 'include',
    'user', 'safety_identifier', 'prompt_cache_key', 'prompt_cache_retention', 'service_tier', 'stream_options',
]);
const HANDLED = new Set([
    'model', 'input', 'instructions', 'stream', 'tools', 'tool_choice', 'parallel_tool_calls', 'text',
    'reasoning', 'store', 'previous_response_id', 'metadata', 'background', 'conversation', 'prompt',
]);
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function parseTools(tools, ignored) {
    if (tools === undefined || tools === null) return [];
    if (!Array.isArray(tools)) throw invalidRequest('tools must be an array.', 'tools');
    const parsed = [];
    tools.forEach((tool, index) => {
        if (tool?.type === 'function' || tool?.type === 'custom') {
            if (typeof tool.name !== 'string' || !/^[\w.-]{1,128}$/.test(tool.name)) {
                throw invalidRequest('Tool names must be letters, digits, _ . or -.', `tools[${index}].name`);
            }
            parsed.push({
                name: tool.name,
                description: typeof tool.description === 'string' ? tool.description : '',
                parameters: tool.type === 'function' ? tool.parameters : undefined,
                kind: tool.type,
            });
        } else {
            ignored.add(`tools.${tool?.type || 'unknown'}`);
        }
    });
    return parsed;
}

function parseContent(content, param, media, role) {
    if (typeof content === 'string') return { text: content, media: [] };
    if (!Array.isArray(content)) throw invalidRequest('content must be a string or an array of parts.', param);
    const texts = [];
    const attachments = [];
    content.forEach((part, index) => {
        const where = `${param}[${index}]`;
        const options = { ...media, param: where };
        switch (part?.type) {
            case 'input_text': case 'output_text': case 'text': case 'summary_text':
                texts.push(String(part.text ?? '')); break;
            case 'refusal': texts.push(String(part.refusal ?? '')); break;
            case 'input_image':
                if (part.file_id) throw unsupported('input_image.file_id requires the Files API; send image_url instead.', where);
                attachments.push(imageFromUrl(part.image_url, options)); break;
            case 'input_file': attachments.push(fileAttachment(part, options)); break;
            case 'input_audio': attachments.push(audioFromBase64(part.input_audio?.data ?? part.data, part.input_audio?.format ?? part.format, options)); break;
            case 'input_video': attachments.push(videoFromUrl(part.video_url?.url ?? part.video_url ?? part.url, options)); break;
            default: throw unsupported(`Unsupported content part type '${part?.type}'.`, where);
        }
    });
    if (role !== 'user' && attachments.length) throw invalidRequest('Only user messages may carry attachments.', param);
    for (const file of attachments.filter((a) => a.kind === 'text')) texts.push(fileBlock(file.filename, file.text));
    return { text: texts.join(''), media: attachments.filter((a) => a.kind !== 'text') };
}

function outputText(output) {
    if (typeof output === 'string') return output;
    if (Array.isArray(output)) return output.map((part) => part?.text ?? '').join('');
    return JSON.stringify(output ?? '');
}

/** Convert Responses input items into canonical messages. */
export function parseInputItems(input, media, resolveItem) {
    const items = typeof input === 'string' ? [{ type: 'message', role: 'user', content: input }] : input;
    if (!Array.isArray(items)) throw invalidRequest('input must be a string or an array of items.', 'input');
    const messages = [];
    const pushAssistantCall = (call) => {
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant' && !last.content) last.toolCalls.push(call);
        else messages.push({ role: 'assistant', content: '', media: [], toolCalls: [call] });
    };
    items.forEach((raw, index) => {
        const param = `input[${index}]`;
        const item = raw?.type === 'item_reference' ? resolveItem(raw.id, param) : raw;
        const type = item?.type ?? (item?.role ? 'message' : undefined);
        switch (type) {
            case 'message': {
                const role = item.role === 'developer' ? 'system' : item.role;
                if (!['system', 'user', 'assistant'].includes(role)) throw invalidRequest('role must be user, assistant, system or developer.', `${param}.role`);
                const { text, media: attachments } = parseContent(item.content, `${param}.content`, media, role);
                messages.push({ role, content: text, media: attachments, ...(role === 'assistant' ? { toolCalls: [] } : {}) });
                break;
            }
            case 'function_call':
            case 'custom_tool_call':
                if (typeof item.name !== 'string' || typeof item.call_id !== 'string') throw invalidRequest(`${type} needs name and call_id.`, param);
                pushAssistantCall({
                    id: item.call_id,
                    name: item.name,
                    arguments: type === 'custom_tool_call' ? JSON.stringify({ input: String(item.input ?? '') }) : String(item.arguments || '{}'),
                });
                break;
            case 'function_call_output':
            case 'custom_tool_call_output':
                if (typeof item.call_id !== 'string') throw invalidRequest(`${type} needs call_id.`, param);
                messages.push({ role: 'tool', content: outputText(item.output), media: [], toolCallId: item.call_id });
                break;
            case 'reasoning':
                break;
            default:
                throw unsupported(`Unsupported input item type '${type}'.`, param);
        }
    });
    return messages;
}

/**
 * Validate a Responses API request into canonical form (+ Responses extras).
 * @param {unknown} body
 * @param {{ maxBytes: number }} media
 * @param {{ history: (id: string) => object[]|null, item: (id: string) => object|null }} store
 */
export function parseResponsesRequest(body, media, store) {
    if (!isObject(body)) throw invalidRequest('Request body must be a JSON object.');
    if (typeof body.model !== 'string' || !body.model.trim()) throw invalidRequest('model is required (see GET /v1/models).', 'model');
    if (body.input === undefined) throw invalidRequest('input is required.', 'input');
    if (body.background === true) throw unsupported('background responses are not supported; stream instead.', 'background');
    if (body.conversation) throw unsupported('The Conversations API is not supported; use previous_response_id.', 'conversation');
    if (body.prompt) throw unsupported('Stored prompt templates are not supported.', 'prompt');
    if (body.instructions !== undefined && body.instructions !== null && typeof body.instructions !== 'string') {
        throw invalidRequest('instructions must be a string.', 'instructions');
    }
    const ignored = new Set(Object.keys(body).filter((key) => IGNORED.has(key) || !HANDLED.has(key)));
    const tools = parseTools(body.tools, ignored);
    let history = [];
    if (body.previous_response_id) {
        history = store.history(body.previous_response_id);
        if (!history) throw invalidRequest(`Previous response '${body.previous_response_id}' was not found (it may have expired or been stored with store=false).`, 'previous_response_id', 'previous_response_not_found');
    }
    const resolveItem = (id, param) => {
        const item = store.item(id);
        if (!item) throw invalidRequest(`Item '${id}' was not found.`, param);
        return item;
    };
    const input = parseInputItems(body.input, media, resolveItem);
    const system = body.instructions ? [{ role: 'system', content: body.instructions, media: [] }] : [];
    return {
        model: body.model.trim(),
        messages: [...system, ...history, ...input],
        inputMessages: input,
        history,
        tools,
        toolChoice: parseToolChoice(body.tool_choice, tools),
        parallelToolCalls: body.parallel_tool_calls !== false,
        format: parseResponseFormat(body.text?.format, 'text.format'),
        reasoningEffort: typeof body.reasoning?.effort === 'string' ? body.reasoning.effort : null,
        stop: [],
        n: 1,
        stream: body.stream === true,
        store: body.store !== false,
        echo: {
            instructions: body.instructions ?? null,
            metadata: isObject(body.metadata) ? body.metadata : {},
            previous_response_id: body.previous_response_id ?? null,
            parallel_tool_calls: body.parallel_tool_calls !== false,
            tool_choice: body.tool_choice ?? 'auto',
            tools: Array.isArray(body.tools) ? body.tools : [],
            text: body.text?.format ? { format: body.text.format } : { format: { type: 'text' } },
            reasoning: { effort: body.reasoning?.effort ?? null, summary: body.reasoning?.summary ?? null },
            temperature: body.temperature ?? null,
            top_p: body.top_p ?? null,
            max_output_tokens: body.max_output_tokens ?? null,
            user: body.user ?? null,
            store: body.store !== false,
            truncation: body.truncation ?? 'disabled',
        },
        ignored: [...ignored],
    };
}
