import crypto from 'node:crypto';
import { toApiError } from '../server/errors.js';
import { parseChatRequest } from './chat-request.js';
import { chatUsage, generate } from './generate.js';
import { buildPrompt } from './prompt.js';
import { inlineRemoteAttachments } from './remote-media.js';
import { openSse } from './sse-writer.js';
import { assertPublicUrls } from './url-guard.js';

const completionId = () => `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
const now = () => Math.floor(Date.now() / 1000);

function toolCallsJson(calls) {
    return calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }));
}

function chatMessage(result, legacy) {
    const calls = result.toolCalls.length ? toolCallsJson(result.toolCalls) : null;
    return {
        role: 'assistant',
        content: result.content || (calls ? null : ''),
        refusal: null,
        annotations: [],
        ...(calls && legacy ? { function_call: calls[0].function } : {}),
        ...(calls && !legacy ? { tool_calls: calls } : {}),
        ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
    };
}

const finishReason = (result, legacy) => (legacy && result.finish === 'tool_calls' ? 'function_call' : result.finish);

/**
 * POST /v1/chat/completions
 * @param {{ runner: object, catalog: object, limits: { maxBytes: number } }} deps
 */
export function chatCompletionsHandler({ runner, catalog, limits }) {
    return async (req, res) => {
        const request = parseChatRequest(req.body, limits);
        const model = await catalog.resolve(request.model);
        const prompt = buildPrompt(request, model);
        await assertPublicUrls(prompt.parts);
        if (request.ignored.length) res.set('x-gateway-ignored-params', request.ignored.join(','));
        await req.withSlot(async (signal) => {
            const ready = await inlineRemoteAttachments(prompt, { ...limits, signal });
            return request.stream
                ? streamChat({ req, res, runner, request, prompt: ready, model, signal })
                : jsonChat({ res, runner, request, prompt: ready, model, signal });
        }, request.n);
    };
}

async function jsonChat({ res, runner, request, prompt, model, signal }) {
    const results = await Promise.all(Array.from({ length: request.n }, () => generate({ runner, prompt, request, signal })));
    res.json({
        id: completionId(),
        object: 'chat.completion',
        created: now(),
        model: model.id,
        system_fingerprint: null,
        choices: results.map((result, index) => ({
            index, message: chatMessage(result, request.legacyFunctions), logprobs: null, finish_reason: finishReason(result, request.legacyFunctions),
        })),
        usage: chatUsage(results.map((r) => r.usage)),
    });
}

async function streamChat({ req, res, runner, request, prompt, model, signal }) {
    const id = completionId();
    const created = now();
    const sse = openSse(res);
    const chunk = (index, delta, finishReason = null) => sse.send({
        id, object: 'chat.completion.chunk', created, model: model.id, system_fingerprint: null,
        choices: [{ index, delta, logprobs: null, finish_reason: finishReason }],
        ...(request.includeUsage ? { usage: null } : {}),
    });

    for (let index = 0; index < request.n; index += 1) chunk(index, { role: 'assistant', content: '', refusal: null });
    try {
        const results = await Promise.all(Array.from({ length: request.n }, (_, index) => generate({
            runner, prompt, request, signal,
            onText: (text) => chunk(index, { content: text }),
            onReasoning: (text) => chunk(index, { reasoning_content: text }),
        }).then((result) => {
            const calls = toolCallsJson(result.toolCalls);
            if (calls.length && request.legacyFunctions) chunk(index, { function_call: calls[0].function });
            else if (calls.length) chunk(index, { tool_calls: calls.map((call, position) => ({ index: position, ...call })) });
            chunk(index, {}, finishReason(result, request.legacyFunctions));
            return result;
        })));
        if (request.includeUsage) {
            sse.send({ id, object: 'chat.completion.chunk', created, model: model.id, system_fingerprint: null, choices: [], usage: chatUsage(results.map((r) => r.usage)) });
        }
        sse.raw('data: [DONE]\n\n');
    } catch (error) {
        if (!signal.aborted || error?.status) {
            const apiError = toApiError(error);
            req.log.warn('Chat stream failed', { status: apiError.status, code: apiError.code, error: apiError.message });
            sse.send(apiError.toJSON());
            sse.raw('data: [DONE]\n\n');
        }
    } finally {
        sse.end();
    }
}
