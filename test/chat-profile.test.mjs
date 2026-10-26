import { it } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { CHAT_AGENT, CHAT_SYSTEM } from '../src/opencode/chat-plugin.js';

async function fixture() {
    const hooks = new Map();
    const tools = [{ id: 'shell' }, { id: 'read' }, { id: 'execute' }, { id: 'browser' }];
    const agents = new Map([['plan', { id: 'plan' }]]);
    let evaluate;
    const close = await plugin.setup({
        app: { version: '2.1.2' },
        tool: { transform: async (fn) => fn({ list: () => [...tools], remove: (id) => tools.splice(tools.findIndex((t) => t.id === id), 1) }) },
        agent: { transform: async (fn) => fn({ list: () => [...agents.values()], remove: (id) => agents.delete(id), update: (id, edit) => { const a = { id }; edit(a); agents.set(id, a); }, default: () => {} }) },
        permission: { hook: async (_, fn) => { evaluate = fn; } },
        session: { hook: async (name, fn) => hooks.set(name, fn) },
        event: { subscribe: async function* () {} },
    });
    return { hooks, tools, agents, evaluate, close };
}

it('rebuilds model input solely from admitted caller data and blocks every auxiliary/replay route', async () => {
    const f = await fixture();
    try {
        assert.deepEqual(f.tools, []);
        assert.deepEqual([...f.agents.keys()], [CHAT_AGENT]);
        const permission = { action: 'shell', effect: 'allow' };
        f.evaluate(permission);
        assert.equal(permission.effect, 'deny');
        for (const [sessionID, text] of [['one', 'First caller'], ['two', 'Second caller']]) {
            f.hooks.get('prompt')({ sessionID, prompt: { text }, metadata: { zengateChat: { version: 1, system: `System ${text}` } } });
        }
        for (const [sessionID, text] of [['two', 'Second caller'], ['one', 'First caller']]) {
            const event = { sessionID, agent: CHAT_AGENT, system: [{ text: 'PRIVATE path instructions' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'PRIVATE environment reminder' }] }], tools: { shell: {} }, options: { arbitrary: 'PRIVATE metadata' } };
            f.hooks.get('context')(event);
            assert.deepEqual(event.system, [{ type: 'text', text: CHAT_SYSTEM }, { type: 'text', text: `System ${text}` }]);
            assert.deepEqual(event.messages, [{ role: 'user', content: [{ type: 'text', text }] }]);
            assert.deepEqual(event.tools, {});
            assert.deepEqual(event.options, {});
            assert.throws(() => f.hooks.get('context')(event), /unverified or additional/);
        }
        for (const hook of ['generate', 'compaction']) assert.throws(() => f.hooks.get(hook)({}), /unverified or additional/);
        const title = {};
        f.hooks.get('title')(title);
        assert.equal(title.result, 'Chat');
        const retry = { decision: { retry: true, delay: 0 } };
        f.hooks.get('retry')(retry);
        assert.deepEqual(retry.decision, { retry: false });
        for (const extra of [{}, { metadata: { zengateChat: { version: 1, system: 42 } } }, { prompt: { text: 'x', files: [{ uri: 'file:///secret' }] } }, { prompt: { text: 'x', skills: [{ id: 'secret' }] } }, { prompt: { text: 'x', agents: [{ id: 'plan' }] } }]) {
            const event = { sessionID: 'bad', prompt: { text: 'x' }, metadata: { zengateChat: { version: 1, system: '' } }, ...extra };
            if (Object.keys(extra).length === 0) delete event.metadata;
            assert.throws(() => f.hooks.get('prompt')(event), /unverified or additional/);
        }
    } finally { f.close(); }
});

it('rejects an unvalidated CLI runtime before installing hooks', async () => {
    await assert.rejects(plugin.setup({ app: { version: '2.1.3' } }), /validated OpenCode 2.1.2/);
});
