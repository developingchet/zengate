import { invalidRequest, unsupported } from '../server/errors.js';
import { audioFromBase64, fileAttachment, imageFromUrl, videoFromUrl } from './media.js';
import { newCallId } from './tool-calls.js';

/**
 * Parameters that are accepted for compatibility but cannot be applied
 * through OpenCode (sampling and token limits are set by the model/agent).
 * They are reported back in the `x-gateway-ignored-params` header.
 */
const IGNORED = new Set([
    'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'presence_penalty', 'frequency_penalty',
    'seed', 'logit_bias', 'user', 'metadata', 'store', 'service_tier', 'prompt_cache_key', 'prompt_cache_retention',
    'safety_identifier', 'verbosity', 'prediction', 'web_search_options', 'top_k', 'min_p', 'repetition_penalty',
]);
const HANDLED = new Set([
    'model', 'messages', 'stream', 'stream_options', 'n', 'stop', 'response_format', 'reasoning_effort',
    'tools', 'tool_choice', 'parallel_tool_calls', 'functions', 'function_call', 'logprobs', 'top_logprobs',
    'modalities', 'audio',
]);
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool', 'function']);
const MAX_MESSAGES = 2000;
export const MAX_CHOICES = 4;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function parseTools(tools, param = 'tools') {
    if (tools === undefined || tools === null) return [];
    if (!Array.isArray(tools)) throw invalidRequest('tools must be an array.', param);
    const seen = new Set();
    return tools.map((tool, index) => {
        const fn = tool?.type === 'function' ? tool.function : tool?.type === undefined ? tool : null;
        if (!isObject(fn) || typeof fn.name !== 'string' || !/^[\w.-]{1,128}$/.test(fn.name)) {
            throw invalidRequest('Each tool must be {"type":"function","function":{"name":...}} with a name of letters, digits, _ . or -.', `${param}[${index}]`);
        }
        if (seen.has(fn.name)) throw invalidRequest(`Duplicate tool name '${fn.name}'.`, `${param}[${index}]`);
        seen.add(fn.name);
        if (fn.parameters !== undefined && !isObject(fn.parameters)) throw invalidRequest('function.parameters must be a JSON Schema object.', `${param}[${index}]`);
        return { name: fn.name, description: typeof fn.description === 'string' ? fn.description : '', parameters: fn.parameters, kind: 'function' };
    });
}

export function parseToolChoice(choice, tools, param = 'tool_choice') {
    if (choice === undefined || choice === null) return 'auto';
    if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
    const name = choice?.function?.name ?? choice?.name;
    if (typeof name === 'string') {
        if (!tools.some((tool) => tool.name === name)) throw invalidRequest(`tool_choice names '${name}', which is not in tools.`, param);
        return { name };
    }
    if (choice?.type === 'allowed_tools') return choice.mode === 'required' ? 'required' : 'auto';
    throw invalidRequest('tool_choice must be "auto", "none", "required" or a named function.', param);
}

function textOf(parts, param) {
    return parts.map((part, index) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' || part?.type === 'refusal') return String(part.text ?? part.refusal ?? '');
        throw invalidRequest('Only text parts are allowed here.', `${param}[${index}]`);
    }).join('');
}

function parseUserContent(content, param, media) {
    if (typeof content === 'string') return { text: content, media: [] };
    if (content === null || content === undefined) return { text: '', media: [] };
    if (!Array.isArray(content)) throw invalidRequest('content must be a string or an array of content parts.', param);
    const texts = [];
    const attachments = [];
    content.forEach((part, index) => {
        const where = `${param}[${index}]`;
        const options = { ...media, param: where };
        switch (part?.type) {
            case 'text': texts.push(String(part.text ?? '')); break;
            case 'image_url': attachments.push(imageFromUrl(typeof part.image_url === 'string' ? part.image_url : part.image_url?.url, options)); break;
            case 'input_audio': attachments.push(audioFromBase64(part.input_audio?.data, part.input_audio?.format, options)); break;
            case 'file': attachments.push(fileAttachment(part.file || {}, options)); break;
            case 'video_url': attachments.push(videoFromUrl(typeof part.video_url === 'string' ? part.video_url : part.video_url?.url, options)); break;
            case 'refusal': texts.push(String(part.refusal ?? '')); break;
            default:
                throw unsupported(`Unsupported content part type '${part?.type}'. Use text, image_url, input_audio, file or video_url.`, where);
        }
    });
    const inlined = attachments.filter((a) => a.kind === 'text');
    for (const file of inlined) texts.push(`\n<file name="${file.filename || 'attachment'}">\n${file.text}\n</file>\n`);
    return { text: texts.join(''), media: attachments.filter((a) => a.kind !== 'text') };
}

function parseAssistantCalls(message, param) {
    const calls = [];
    if (Array.isArray(message.tool_calls)) {
        message.tool_calls.forEach((call, index) => {
            const name = call?.function?.name;
            if (typeof name !== 'string') throw invalidRequest('tool_calls[].function.name is required.', `${param}.tool_calls[${index}]`);
            const args = call.function.arguments;
            calls.push({ id: String(call.id || newCallId()), name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) });
        });
    }
    if (isObject(message.function_call) && typeof message.function_call.name === 'string') {
        calls.push({ id: `call_${message.function_call.name}`, name: message.function_call.name, arguments: String(message.function_call.arguments || '{}') });
    }
    return calls;
}

export function parseChatMessages(messages, media) {
    if (!Array.isArray(messages) || messages.length === 0) throw invalidRequest('messages must be a non-empty array.', 'messages');
    if (messages.length > MAX_MESSAGES) throw invalidRequest(`messages may contain at most ${MAX_MESSAGES} entries.`, 'messages');
    return messages.map((message, index) => {
        const param = `messages[${index}]`;
        if (!isObject(message) || !ROLES.has(message.role)) {
            throw invalidRequest(`${param}.role must be one of: system, developer, user, assistant, tool.`, `${param}.role`);
        }
        const { role } = message;
        if (role === 'system' || role === 'developer') {
            const text = Array.isArray(message.content) ? textOf(message.content, `${param}.content`) : String(message.content ?? '');
            return { role: 'system', content: text, media: [] };
        }
        if (role === 'tool' || role === 'function') {
            const text = Array.isArray(message.content) ? textOf(message.content, `${param}.content`) : String(message.content ?? '');
            const toolCallId = role === 'function' ? `call_${message.name}` : message.tool_call_id;
            if (typeof toolCallId !== 'string' || !toolCallId) throw invalidRequest('Tool messages need tool_call_id.', `${param}.tool_call_id`);
            return { role: 'tool', content: text, media: [], toolCallId, name: typeof message.name === 'string' ? message.name : undefined };
        }
        if (role === 'assistant') {
            const text = Array.isArray(message.content) ? textOf(message.content, `${param}.content`) : String(message.content ?? '');
            return { role: 'assistant', content: text, media: [], toolCalls: parseAssistantCalls(message, param) };
        }
        const { text, media: attachments } = parseUserContent(message.content, `${param}.content`, media);
        return { role: 'user', content: text, media: attachments };
    });
}

export function parseResponseFormat(format, param = 'response_format') {
    if (format === undefined || format === null || format?.type === 'text') return null;
    if (format?.type === 'json_object') return { type: 'json_object' };
    if (format?.type === 'json_schema') {
        const spec = format.json_schema ?? format;
        if (!isObject(spec?.schema)) throw invalidRequest('json_schema.schema must be a JSON Schema object.', param);
        return { type: 'json_schema', name: spec.name || 'response', schema: spec.schema };
    }
    throw invalidRequest('response_format.type must be text, json_object or json_schema.', param);
}

function parseStop(stop) {
    if (stop === undefined || stop === null) return [];
    const list = Array.isArray(stop) ? stop : [stop];
    if (list.length > 4 || list.some((s) => typeof s !== 'string')) throw invalidRequest('stop must be a string or up to 4 strings.', 'stop');
    return list.filter(Boolean);
}

/**
 * Validate a Chat Completions request into the gateway's canonical form.
 * @param {unknown} body parsed JSON body
 * @param {{ maxBytes: number }} media per-attachment limits
 */
export function parseChatRequest(body, media) {
    if (!isObject(body)) throw invalidRequest('Request body must be a JSON object.');
    if (typeof body.model !== 'string' || !body.model.trim()) throw invalidRequest('model is required (see GET /v1/models).', 'model');
    if (body.logprobs === true) throw unsupported('logprobs are not available through OpenCode.', 'logprobs');
    if (body.audio || (Array.isArray(body.modalities) && body.modalities.some((m) => m !== 'text'))) {
        throw unsupported('Only text output is supported (modalities: ["text"]).', 'modalities');
    }
    const n = body.n ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > MAX_CHOICES) throw invalidRequest(`n must be an integer from 1 to ${MAX_CHOICES}.`, 'n');
    const legacyTools = Array.isArray(body.functions) ? body.functions.map((fn) => ({ type: 'function', function: fn })) : undefined;
    const tools = parseTools(body.tools ?? legacyTools, body.tools ? 'tools' : 'functions');
    const legacyChoice = typeof body.function_call === 'string' ? body.function_call : body.function_call?.name ? { name: body.function_call.name } : undefined;
    const ignored = Object.keys(body).filter((key) => IGNORED.has(key) || !HANDLED.has(key));
    return {
        model: body.model.trim(),
        messages: parseChatMessages(body.messages, media),
        tools,
        toolChoice: parseToolChoice(body.tool_choice ?? legacyChoice, tools),
        // Legacy `functions` clients expect a single `function_call` back.
        legacyFunctions: !body.tools && Boolean(legacyTools),
        parallelToolCalls: body.parallel_tool_calls !== false && !(!body.tools && legacyTools),
        format: parseResponseFormat(body.response_format),
        reasoningEffort: typeof body.reasoning_effort === 'string' ? body.reasoning_effort : null,
        stop: parseStop(body.stop),
        n,
        stream: body.stream === true,
        includeUsage: body.stream_options?.include_usage === true,
        ignored,
    };
}
