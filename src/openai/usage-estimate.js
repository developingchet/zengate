import { CHARS_PER_TOKEN } from './length-limit.js';

export const NO_USAGE = Object.freeze({ input: 0, output: 0, reasoning: 0, cacheRead: 0 });

export const estimateTokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);

/**
 * Input tokens OpenCode adds on top of the prompt text (its system prompt and
 * tool list), as last measured for each model. Model ids come from the
 * catalog, so the map stays small.
 */
const overheadByModel = new Map();
let lastOverhead = 0;

const modelKey = (prompt) => `${prompt.model?.providerID}/${prompt.model?.modelID}`;

function promptTokens(prompt) {
    const texts = [prompt.system || '', ...prompt.parts.filter((part) => part.type === 'text').map((part) => part.text)];
    return texts.reduce((sum, text) => sum + estimateTokens(text), 0);
}

/** Remember how far a finished turn's real input count was above the prompt text alone. */
export function learnPromptOverhead(prompt, usage) {
    const measured = usage.input + usage.cacheRead;
    if (!(measured > 0)) return;
    lastOverhead = Math.max(0, measured - promptTokens(prompt));
    overheadByModel.set(modelKey(prompt), lastOverhead);
}

/**
 * Usage for a turn cut off before OpenCode reported any: the output side
 * from the text that was produced, the input side from the prompt plus the
 * overhead last measured for this model (or any model, before the first).
 */
export function estimateUsage(prompt, content, reasoning) {
    return {
        ...NO_USAGE,
        input: promptTokens(prompt) + (overheadByModel.get(modelKey(prompt)) ?? lastOverhead),
        output: estimateTokens(content),
        reasoning: estimateTokens(reasoning),
    };
}
