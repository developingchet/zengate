import { ApiError } from '../server/errors.js';
import { generate } from './generate.js';
import { buildPrompt } from './prompt.js';
import { inlineRemoteAttachments } from './remote-media.js';
import { createResponseBuilder } from './response-builder.js';
import { parseResponsesRequest } from './responses-request.js';
import { openSse } from './sse-writer.js';
import { assertPublicUrls } from './url-guard.js';

function assistantHistory(result) {
    return { role: 'assistant', content: result.content, media: [], toolCalls: result.toolCalls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })) };
}

/**
 * POST /v1/responses, GET /v1/responses/:id, DELETE /v1/responses/:id
 * @param {{ runner: object, catalog: object, store: object, limits: { maxBytes: number } }} deps
 */
export function responsesHandlers({ runner, catalog, store, limits }) {
    const create = async (req, res) => {
        const scoped = store.scope(req.clientId);
        const request = parseResponsesRequest(req.body, limits, scoped);
        const model = await catalog.resolve(request.model);
        const prompt = buildPrompt(request, model);
        await assertPublicUrls(prompt.parts);
        if (request.ignored.length) res.set('x-gateway-ignored-params', request.ignored.join(','));

        await req.withSlot(async (signal) => {
            const ready = await inlineRemoteAttachments(prompt, { ...limits, signal });
            const sse = request.stream ? openSse(res) : null;
            const builder = createResponseBuilder({
                model: model.id,
                echo: request.echo,
                emit: sse ? (event) => sse.send(event, event.type) : undefined,
            });
            builder.start();
            try {
                const result = await generate({
                    runner, prompt: ready, request, signal,
                    onText: (text) => builder.textDelta(text),
                    onReasoning: (text) => builder.reasoningDelta(text),
                });
                const response = builder.finish(result);
                if (request.store) scoped.save(response, [...request.history, ...request.inputMessages, assistantHistory(result)]);
                if (!sse) res.json(response);
            } catch (error) {
                if (!sse) throw error;
                const apiError = builder.fail(error);
                req.log.warn('Responses stream failed', { status: apiError.status, code: apiError.code, error: apiError.message });
            } finally {
                sse?.end();
            }
        });
    };

    const retrieve = (req, res) => {
        const response = store.scope(req.clientId).response(req.params.id);
        if (!response) throw new ApiError(404, `No response with id '${req.params.id}' (responses are kept in memory for one hour).`, { code: 'not_found' });
        res.json(response);
    };

    const remove = (req, res) => {
        if (!store.scope(req.clientId).delete(req.params.id)) throw new ApiError(404, `No response with id '${req.params.id}'.`, { code: 'not_found' });
        res.json({ id: req.params.id, object: 'response', deleted: true });
    };

    return { create, retrieve, remove };
}
