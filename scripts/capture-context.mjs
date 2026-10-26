#!/usr/bin/env node
// Real-CLI contract probe for #38. Uses only a synthetic local model and prints
// context categories, never captured prompts, paths or credentials.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolveOpencodeBinary, spawnCommand } from '../src/opencode/binary.js';
import { backendEnv, createIsolatedRoot, removeIsolatedRoot } from '../src/opencode/isolation.js';
import { createOpencodeClientV2 } from '../src/opencode/client-v2.js';

const captures = [];
const permissions = [
    { action: '*', resource: '*', effect: 'ask' },
    { action: 'execute', resource: '*', effect: 'deny' },
    { action: 'browser', resource: '*', effect: 'deny' },
];
const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    captures.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta, finish_reason) => `data: ${JSON.stringify({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.end(frame({ role: 'assistant', content: 'Captured' }, null) + frame({}, 'stop') + 'data: [DONE]\n\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const dirs = createIsolatedRoot();
let proc;
try {
    const config = {
        autoupdate: false,
        model: 'capture/dummy',
        default_agent: 'zengate-chat',
        policies: [
            { action: 'provider.use', resource: '*', effect: 'deny' },
            { action: 'provider.use', resource: 'capture', effect: 'allow' },
        ],
        providers: { capture: {
            package: '@opencode/ai/providers/openai-compatible',
            settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'synthetic-capture-key' },
            models: { dummy: { modelID: 'dummy', capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 32768, output: 8192 } } },
        } },
        agents: { 'zengate-chat': { mode: 'primary', system: 'You are a conversational assistant. Answer directly.', permissions } },
    };
    const env = { ...backendEnv(dirs, 'synthetic-server-password'), OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
    const binary = resolveOpencodeBinary(process.env.OPENCODE_PATH || '');
    const command = spawnCommand(binary.path, ['serve', '--hostname', '127.0.0.1', '--port', '0']);
    proc = spawn(command.command, command.args, { cwd: dirs.workspace, env, windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'pipe'] });
    const signal = AbortSignal.timeout(60000);
    const port = await new Promise((resolve, reject) => {
        let output = '';
        const done = (error, value) => {
            signal.removeEventListener('abort', aborted);
            proc.stdout.off('data', data);
            proc.stderr.off('data', data);
            proc.off('exit', exited);
            proc.off('error', failed);
            if (error) reject(error); else resolve(value);
        };
        const aborted = () => done(new Error('CLI startup timed out'));
        const failed = (error) => done(error);
        const exited = () => done(new Error(`CLI exited during startup: ${output.slice(-1500)}`));
        const data = (chunk) => {
            output = (output + chunk).slice(-4096);
            const found = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output.replace(/\x1b\[[0-9;]*m/g, ''));
            if (found) done(null, Number(found[1]));
        };
        proc.stdout.on('data', data);
        proc.stderr.on('data', data);
        proc.once('error', failed);
        proc.once('exit', exited);
        signal.addEventListener('abort', aborted, { once: true });
    });
    const client = createOpencodeClientV2({ baseUrl: `http://127.0.0.1:${port}`, password: 'synthetic-server-password' });
    const health = await client.health({ signal });
    await client.providers({ signal });
    const session = await client.createSession({ signal });
    try {
        const result = await client.prompt(session.id, {
            agent: 'zengate-chat', model: { providerID: 'capture', modelID: 'dummy' },
            system: 'Client instruction marker: synthetic-client-system.', parts: [{ type: 'text', text: 'Say hello.' }],
        }, { signal });
        assert.equal(result.info.error, undefined);
        assert.ok(captures.length > 0, 'the real CLI must dispatch to the local provider');
        const summary = captures.map((body) => {
            const text = JSON.stringify(body.messages || []);
            return {
                conversationalIdentity: text.includes('You are a conversational assistant.'),
                clientInstruction: text.includes('synthetic-client-system'),
                workspaceContext: text.includes(dirs.workspace) || text.includes(dirs.workspace.replaceAll('\\', '\\\\')),
                environmentContext: /Working directory|workspace root|<environment|<env>|Platform:/i.test(text),
                tools: (body.tools || []).map((tool) => tool.function?.name || tool.name),
            };
        });
        console.log(JSON.stringify({ gateway: '1.3.1 working tree', cli: health.version, provider: 'local synthetic capture/dummy', requests: summary }, null, 2));
        assert.ok(summary.some((entry) => entry.conversationalIdentity), 'verify the custom agent was applied');
        assert.ok(summary.some((entry) => entry.workspaceContext || entry.environmentContext), 'custom agent alone still carries backend context');
        assert.ok(summary.every((entry) => !entry.tools.includes('execute') && !entry.tools.includes('browser')), 'session denial removes execute/browser');
    } finally { await client.deleteSession(session.id).catch(() => {}); }
} finally {
    if (proc && proc.exitCode === null) {
        const exited = once(proc, 'exit');
        proc.kill();
        await exited;
    }
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    removeIsolatedRoot(dirs.root);
}
