// OpenCode 2.1.2 Promise plugin. No package imports: the CLI loads this local
// module inside its isolated home. This is an input boundary, not output filtering.
export const CHAT_AGENT = 'zengate-chat';
export const CHAT_PLUGIN_ID = 'zengate.strict-chat.v1';
export const CHAT_SYSTEM = 'You are a conversational assistant. Answer the supplied conversation directly. You have no host tools or access to a runtime environment.';

export default {
    id: CHAT_PLUGIN_ID,
    async setup(ctx) {
        if (ctx.app.version !== '2.1.2') throw new Error('Strict chat requires the validated OpenCode 2.1.2 runtime');
        const admitted = new Map();
        const fail = () => { throw new Error('Strict chat rejected an unverified or additional model request'); };
        await ctx.tool.transform((editor) => {
            for (const tool of editor.list()) editor.remove(tool.id);
        });
        await ctx.agent.transform((editor) => {
            for (const agent of editor.list()) editor.remove(agent.id);
            editor.update(CHAT_AGENT, (agent) => {
                agent.name = CHAT_AGENT;
                agent.mode = 'primary';
                agent.hidden = false;
                agent.system = CHAT_SYSTEM;
                agent.permissions = [{ action: '*', resource: '*', effect: 'deny' }];
            });
            editor.default(CHAT_AGENT);
        });
        await ctx.permission.hook('evaluate', (event) => { event.effect = 'deny'; });
        await ctx.session.hook('prompt', (event) => {
            const marker = event.metadata?.zengateChat;
            if (marker?.version !== 1 || typeof marker.system !== 'string' || typeof event.prompt.text !== 'string'
                || event.prompt.files?.length || event.prompt.agents?.length || event.prompt.skills?.length) fail();
            if (admitted.size >= 64 && !admitted.has(event.sessionID)) fail();
            admitted.set(event.sessionID, { text: event.prompt.text, system: marker.system, at: Date.now() });
        });
        await ctx.session.hook('context', (event) => {
            const input = admitted.get(event.sessionID);
            admitted.delete(event.sessionID);
            if (event.agent !== CHAT_AGENT || !input) fail();
            event.system = [{ type: 'text', text: CHAT_SYSTEM }, ...(input.system ? [{ type: 'text', text: input.system }] : [])];
            // The gateway renders the entire client conversation into this single
            // admitted text. Never forward OpenCode history/reminders or tool results.
            event.messages = [{ role: 'user', content: [{ type: 'text', text: input.text }] }];
            event.tools = {};
            event.options = {};
        });
        await ctx.session.hook('title', (event) => { event.result = 'Chat'; });
        await ctx.session.hook('generate', fail);
        await ctx.session.hook('compaction', fail);
        await ctx.session.hook('retry', (event) => { event.decision = { retry: false }; });
        const controller = new AbortController();
        void (async () => {
            for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
                if (event.type === 'session.deleted') admitted.delete(event.data.sessionID);
            }
        })().catch(() => {});
        // Interrupted prompts may never reach context. Bound that transient state.
        const timer = setInterval(() => {
            for (const [id, input] of admitted) if (Date.now() - input.at > 3600000) admitted.delete(id);
        }, 60000);
        timer.unref?.();
        return () => { controller.abort(); clearInterval(timer); admitted.clear(); };
    },
};
