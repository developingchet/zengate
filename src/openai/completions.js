import crypto from 'node:crypto';
import { invalidRequest, toApiError, unsupported } from '../server/errors.js';
import { MAX_CHOICES } from './chat-request.js';
import { chatUsage, generate } from './generate.js';
import { setIgnoredParams } from './ignored-params.js';
import { mapLimited } from './map-limited.js';
import { parseMaxTokens } from './length-limit.js';
import { buildPrompt } from './prompt.js';
import { openSse } from './sse-writer.js';

/**
 * Legacy text completions (POST /v1/completions) on top of chat models: the
 * model is asked to continue the prompt and reply with the continuation only.
 */
const CONTINUE_INSTRUCTION = 'Continue the text in the user message from exactly where it stops. '
    + 'Reply with only the continuation: no preamble, no quotes, and do not repeat the given text.';
const IGNORED = new Set(['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'seed', 'logit_bias', 'user', 'best_of']);
const HANDLED = new Set(['model', 'prompt', 'stream', 'stream_options', 'n', 'stop', 'max_tokens', 'echo', 'suffix', 'logprobs']);
const MAX_PROMPT_CHARS = 4 * 1024 * 1024;

const completionId = () => `cmpl-${crypto.randomBytes(12).toString('hex')}`;
const now = () => Math.floor(Date.now() / 1000);

function parsePrompts(prompt) {
    const list = Array.isArray(prompt) ? prompt : [prompt];
    if (list.length === 0 || list.some((item) => typeof item !== 'string')) {
        throw invalidRequest('prompt must be a string or an array of strings (token arrays are not supported).', 'prompt');
    }
    if (list.reduce((sum, item) => sum + item.length, 0) > MAX_PROMPT_CHARS) throw invalidRequest('prompt is too long.', 'prompt');
    return list;
}

function parseStop(stop) {
    if (stop === undefined || stop === null) return [];
    const list = Array.isArray(stop) ? stop : [stop];
    if (list.length > 4 || list.some((s) => typeof s !== 'string')) throw invalidRequest('stop must be a string or up to 4 strings.', 'stop');
    return list.filter(Boolean);
}

/**
 * Validate a completions request. Each prompt becomes its own single-turn
 * chat request; `n` completions are made for each.
 * @param {unknown} body
 */
export function parseCompletionRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidRequest('Request body must be a JSON object.');
    if (typeof body.model !== 'string' || !body.model.trim()) throw invalidRequest('model is required (see GET /v1/models).', 'model');
    if (body.prompt === undefined) throw invalidRequest('prompt is required.', 'prompt');
    if (body.suffix !== undefined && body.suffix !== null && body.suffix !== '') throw unsupported('suffix (fill-in-the-middle) is not supported.', 'suffix');
    if (body.logprobs !== undefined && body.logprobs !== null) throw unsupported('logprobs are not available through OpenCode.', 'logprobs');
    const prompts = parsePrompts(body.prompt);
    const n = body.n ?? 1;
    if (!Number.isInteger(n) || n < 1 || n * prompts.length > MAX_CHOICES) {
        throw invalidRequest(`n times the number of prompts must be from 1 to ${MAX_CHOICES}.`, 'n');
    }
    const shared = {
        model: body.model.trim(),
        tools: [],
        toolChoice: 'auto',
        parallelToolCalls: false,
        format: null,
        reasoningEffort: null,
        stop: parseStop(body.stop),
        maxTokens: parseMaxTokens(body, ['max_tokens']),
    };
    return {
        ...shared,
        prompts,
        requests: prompts.map((text) => ({
            ...shared,
            messages: [{ role: 'system', content: CONTINUE_INSTRUCTION, media: [] }, { role: 'user', content: text, media: [] }],
        })),
        n,
        echo: body.echo === true,
        stream: body.stream === true,
        includeUsage: body.stream_options?.include_usage === true,
        ignored: Object.keys(body).filter((key) => IGNORED.has(key) || !HANDLED.has(key)),
    };
}

/**
 * POST /v1/completions
 * @param {{ runner: object, catalog: object }} deps
 */
export function completionsHandler({ runner, catalog }) {
    return async (req, res) => {
        const parsed = parseCompletionRequest(req.body);
        const model = await catalog.resolve(parsed.model);
        const jobs = parsed.requests.flatMap((request, promptIndex) => Array.from({ length: parsed.n }, () => ({
            request, prompt: buildPrompt(request, model), echo: parsed.echo ? parsed.prompts[promptIndex] : '',
        })));
        setIgnoredParams(res, parsed.ignored);
        await req.withSlot((signal, parallel) => (parsed.stream
            ? streamCompletion({ req, res, runner, parsed, jobs, model, signal, parallel })
            : jsonCompletion({ req, res, runner, jobs, model, signal, parallel })), jobs.length);
    };
}

const run = ({ req, runner, job, signal, onText }) => generate({
    runner, prompt: job.prompt, request: job.request, signal, onText, onFirstToken: req.markFirstToken,
});

async function jsonCompletion({ req, res, runner, jobs, model, signal, parallel }) {
    const results = await mapLimited(jobs, parallel, (job) => run({ req, runner, job, signal }));
    res.json({
        id: completionId(),
        object: 'text_completion',
        created: now(),
        model: model.id,
        system_fingerprint: null,
        choices: results.map((result, index) => ({
            text: `${jobs[index].echo}${result.content}`, index, logprobs: null, finish_reason: result.finish,
        })),
        usage: chatUsage(results.map((r) => r.usage)),
    });
}

async function streamCompletion({ req, res, runner, parsed, jobs, model, signal, parallel }) {
    const id = completionId();
    const created = now();
    const sse = openSse(res);
    const chunk = (choices, usage) => sse.send({
        id, object: 'text_completion', created, model: model.id, system_fingerprint: null, choices,
        ...(usage ? { usage } : {}),
    });
    const text = (index, value, finishReason = null) => chunk([{ text: value, index, logprobs: null, finish_reason: finishReason }]);
    try {
        const results = await mapLimited(jobs, parallel, (job, index) => {
            if (job.echo) text(index, job.echo);
            return run({ req, runner, job, signal, onText: (delta) => text(index, delta) }).then((result) => {
                text(index, '', result.finish);
                return result;
            });
        });
        if (parsed.includeUsage) chunk([], chatUsage(results.map((r) => r.usage)));
        sse.raw('data: [DONE]\n\n');
    } catch (error) {
        if (!signal.aborted || error?.status) {
            const apiError = toApiError(error);
            req.log.warn('Completion stream failed', { status: apiError.status, code: apiError.code, error: apiError.message });
            sse.send(apiError.toJSON());
            sse.raw('data: [DONE]\n\n');
        }
    } finally {
        sse.end();
    }
}
