import crypto from 'node:crypto';
import { escapeFrames } from './markup.js';

/**
 * OpenAI function calling, emulated over a plain-text protocol.
 *
 * OpenCode sessions only expose OpenCode's own tools (which this gateway
 * rejects), so client-defined functions are described in the system prompt
 * and the model answers with <tool_call>{json}</tool_call> blocks. The parser
 * turns those back into standard tool_calls; everything else stays content.
 * Models trained on other conventions sometimes write <function_calls> or
 * <tool_calls> instead, so those spellings are accepted too.
 */
const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';
const TAGS = ['tool_call', 'tool_calls', 'function_call', 'function_calls'];
const OPENERS = [...TAGS.map((tag) => `<${tag}>`), '<function='];
// Group 1: wrapper tag name; group 2: function name in the <function=name> form.
const OPEN_RE = /<(tool_calls?|function_calls?)>|<function=([\w.-]{1,128})>/;
const NAMED_TAIL_RE = /^<function=[\w.-]{0,128}$/;
const MAX_HELD = 150;

export const newCallId = () => `call_${crypto.randomBytes(12).toString('hex')}`;

/**
 * @param {{ name: string, description?: string, parameters?: object, kind?: 'function'|'custom' }[]} tools
 * @param {'auto'|'none'|'required'|{ name: string }} choice
 * @param {boolean} parallel
 */
export function toolInstructions(tools, choice, parallel) {
    if (!tools.length || choice === 'none') return '';
    const lines = [
        '# Client functions',
        'The user\'s application provides the functions listed below. They are NOT native tools: invoking them as a tool fails.',
        'The only way to call one is to write this text block in your reply, with the arguments as a JSON object:',
        `${OPEN}{"name": "<function name>", "arguments": {<arguments>}}${CLOSE}`,
        parallel
            ? 'Write one block per call; several blocks call several functions at once. Write nothing after the last block.'
            : 'Call at most one function per reply. Write nothing after the block.',
        'The application runs the function and sends the result back as a <tool_result> entry. When no call is needed, reply normally without any block.',
    ];
    if (choice === 'required') lines.push('You must call at least one of these functions in this reply by writing a block.');
    if (choice && typeof choice === 'object') lines.push(`You must call the function "${choice.name}" in this reply by writing a block.`);
    lines.push('', 'Functions:');
    for (const tool of tools) {
        lines.push(`- ${tool.name}${tool.description ? `: ${tool.description}` : ''}`);
        if (tool.kind === 'custom') lines.push('  arguments: {"input": "<free-form text input>"}');
        else lines.push(`  arguments JSON Schema: ${JSON.stringify(tool.parameters || { type: 'object', properties: {} })}`);
    }
    return lines.join('\n');
}

/**
 * Render a past call in the same syntax, so history teaches the protocol.
 * Its name and arguments come from the client, so frame tags are escaped.
 */
export function renderToolCall(call) {
    let args = call.arguments;
    try { args = JSON.parse(call.arguments); } catch { /* keep raw string */ }
    return `${OPEN}${escapeFrames(JSON.stringify({ name: call.name, arguments: args }))}${CLOSE}`;
}

/** Length of a trailing fragment that could still grow into an opening tag. */
function heldPrefixLength(text) {
    const lt = text.lastIndexOf('<');
    if (lt < 0 || text.length - lt > MAX_HELD) return 0;
    const tail = text.slice(lt);
    return OPENERS.some((opener) => opener.startsWith(tail)) || NAMED_TAIL_RE.test(tail) ? tail.length : 0;
}

/** Arguments of the <function=name> form: a JSON object or <parameter=key>value</parameter> pairs. */
function namedArguments(body) {
    const params = [...body.matchAll(/<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g)];
    if (!params.length) return jsonValues(body)?.[0] ?? (body.trim() ? null : {});
    return Object.fromEntries(params.map(([, key, raw]) => {
        const value = raw.trim();
        try { return [key, JSON.parse(value)]; } catch { return [key, value]; }
    }));
}

/** Split a block body into top-level JSON values (objects or arrays). */
function jsonValues(body) {
    const text = body.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const values = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            if (ch === '\\') i += 1;
            else if (ch === '"') inString = false;
        } else if (ch === '"') {
            inString = true;
        } else if (ch === '{' || ch === '[') {
            if (depth === 0) start = i;
            depth += 1;
        } else if ((ch === '}' || ch === ']') && depth > 0) {
            depth -= 1;
            if (depth === 0) {
                try { values.push(JSON.parse(text.slice(start, i + 1))); } catch { return null; }
            }
        }
    }
    return values.length ? values.flat() : null;
}

function toCall(parsed, toolsByName) {
    const name = typeof parsed?.name === 'string' ? parsed.name : parsed?.function?.name;
    const tool = toolsByName.get(name);
    if (!tool) return null;
    const rawArgs = parsed.arguments ?? parsed.parameters ?? parsed.input ?? parsed.function?.arguments ?? {};
    let args = rawArgs;
    if (typeof rawArgs === 'string') {
        try { args = JSON.parse(rawArgs); } catch { args = tool.kind === 'custom' ? { input: rawArgs } : null; }
    }
    if (tool.kind === 'custom' && (typeof args !== 'object' || args === null || !('input' in args))) args = { input: typeof args === 'string' ? args : JSON.stringify(args) };
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    return { id: newCallId(), name, kind: tool.kind || 'function', arguments: JSON.stringify(args) };
}

function parseBlock(body, toolsByName) {
    const values = jsonValues(body);
    if (!values) return null;
    const calls = values.map((value) => toCall(value, toolsByName));
    return calls.every(Boolean) ? calls : null;
}

function parseNamed(name, body, toolsByName) {
    const args = namedArguments(body);
    if (args === null) return null;
    const call = toCall({ name, arguments: args }, toolsByName);
    return call ? [call] : null;
}

/** Parse all blocks in `text`; unparseable blocks stay as visible text. */
function extractCalls(text, toolsByName) {
    const calls = [];
    let leftover = '';
    let rest = text;
    while (rest.length) {
        const match = OPEN_RE.exec(rest);
        if (!match) { leftover += rest; break; }
        leftover += rest.slice(0, match.index);
        const named = match[2];
        const close = named ? '</function>' : `</${match[1]}>`;
        const bodyStart = match.index + match[0].length;
        const end = rest.indexOf(close, bodyStart);
        const body = rest.slice(bodyStart, end < 0 ? undefined : end);
        const parsed = named ? parseNamed(named, body, toolsByName) : parseBlock(body, toolsByName);
        if (parsed) calls.push(...parsed);
        else leftover += rest.slice(match.index, end < 0 ? undefined : end + close.length);
        rest = end < 0 ? '' : rest.slice(end + close.length);
    }
    return { text: calls.length ? leftover.trim() : leftover, calls };
}

/**
 * Streaming parser. `push(text)` returns content that is safe to show now;
 * once a call block starts, the rest is held until `finish()`.
 * @param {{ name: string, kind?: string }[]} tools
 */
export function createToolCallParser(tools) {
    const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
    let pending = '';
    let capturing = false;

    return {
        push(text) {
            pending += text;
            if (capturing) return '';
            const match = OPEN_RE.exec(pending);
            if (match) {
                const visible = pending.slice(0, match.index);
                pending = pending.slice(match.index);
                capturing = true;
                return visible;
            }
            const hold = heldPrefixLength(pending);
            const visible = pending.slice(0, pending.length - hold);
            pending = pending.slice(pending.length - hold);
            return visible;
        },
        /** @returns {{ text: string, calls: object[] }} trailing content and parsed calls */
        finish() {
            const rest = pending;
            pending = '';
            return capturing ? extractCalls(rest, toolsByName) : { text: rest, calls: [] };
        },
    };
}
