/**
 * Conversations, inlined files and emulated function calls are framed with
 * pseudo-XML tags in the prompt. Client text must not be able to open or
 * close those frames, or a message could pass itself off as another turn, a
 * tool result or a function call. Only the frame tags are escaped, so other
 * markup in a message reaches the model unchanged.
 */
const FRAME_TAG = /<(\/?)((?:user|assistant|tool_result|tool_calls?|function_calls?)(?=[\s/>])|function=|parameter=)/gi;
const FILE_TAG = /<(\/?)(file)(?=[\s/>])/gi;

/** Escape the conversation and function-call frame tags in client text. */
export function escapeFrames(text) {
    return String(text ?? '').replace(FRAME_TAG, '&lt;$1$2');
}

/** A client-supplied value made safe to place inside a quoted tag attribute. */
export function attributeValue(value, fallback) {
    const text = String(value ?? '').replace(/[^\p{L}\p{M}\p{N}_ .:@+-]/gu, '_').slice(0, 255);
    return text || fallback;
}

/** Escape file frame tags, so message text cannot pass itself off as an attached file. */
export function escapeFileTags(text) {
    return String(text ?? '').replace(FILE_TAG, '&lt;$1$2');
}

/** An inlined text attachment; its content cannot close the file frame. */
export function fileBlock(filename, text) {
    const body = escapeFileTags(escapeFrames(text));
    return `\n<file name="${attributeValue(filename, 'attachment')}">\n${body}\n</file>\n`;
}
