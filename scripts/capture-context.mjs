#!/usr/bin/env node
// Real-CLI contract probe for #38. Uses only a synthetic local model and prints
// context categories, never captured prompts, paths or credentials.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolveBundledOpencodeBinary } from '../src/opencode/binary.js';
import { backendEnv, createIsolatedRoot, removeIsolatedRoot } from '../src/opencode/isolation.js';
import { createOpencodeClientV2 } from '../src/opencode/client-v2.js';
import { installChatProfile } from '../src/opencode/chat-profile.js';
import { createEventHub } from '../src/opencode/events.js';
import { silentLogger } from '../src/logger.js';
import { CHAT_SYSTEM } from '../src/opencode/chat-plugin.js';

const strict = process.argv.includes('--strict');
const toolAttempt = process.argv.includes('--tool-attempt');

const captures = [];
const unexpectedRequests = [];
const permissions = [
    { action: '*', resource: '*', effect: 'ask' },
    { action: 'execute', resource: '*', effect: 'deny' },
    { action: 'browser', resource: '*', effect: 'deny' },
];
const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url !== '/v1/chat/completions') { unexpectedRequests.push(req.url); res.writeHead(404); res.end(); return; }
    captures.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta, finish_reason) => `data: ${JSON.stringify({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    if (toolAttempt && captures.length === 1) {
        const command = 'node -e "require(\'fs\').writeFileSync(\'.boundary-canary\',\'ran\')"';
        res.end(frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_boundary', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command }) } }] }, null) + frame({}, 'tool_calls') + 'data: [DONE]\n\n');
        return;
    }
    res.end(frame({ role: 'assistant', content: 'Captured' }, null) + frame({}, 'stop') + 'data: [DONE]\n\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const dirs = createIsolatedRoot();
let proc;
let hub;
let succeeded = 0;
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
    if (strict) Object.assign(config, installChatProfile(dirs));
    const env = { ...backendEnv(dirs, 'synthetic-server-password'), OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
    const binary = resolveBundledOpencodeBinary();
    proc = spawn(binary.path, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: dirs.workspace, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const client = createOpencodeClientV2({ baseUrl: `http://127.0.0.1:${port}`, password: 'synthetic-server-password', profile: strict ? 'chat' : 'compatible' });
    const health = await client.health({ signal });
    await client.providers({ signal });
    hub = createEventHub({ getClient: () => ({ ...client, adaptEvent(event) {
        if (event.type === 'session.tool.success') succeeded += 1;
        return client.adaptEvent(event);
    } }), logger: silentLogger, ownsAllSessions: true });
    hub.start();
    assert.ok(await hub.waitConnected(5000), 'event enforcement must be connected');
    const session = await client.createSession({ signal });
    try {
        const result = await client.prompt(session.id, {
            agent: 'zengate-chat', model: { providerID: 'capture', modelID: 'dummy' },
            system: 'Client instruction marker: synthetic-client-system.', parts: [{ type: 'text', text: 'Say hello.' }],
        }, { signal });
        if (!(strict && toolAttempt)) assert.equal(result.info.error, undefined);
        assert.equal(succeeded, 0, 'no host tool may succeed');
        assert.equal(fs.existsSync(path.join(dirs.workspace, '.boundary-canary')), false, 'shell canary must never be created');
        if (toolAttempt && !strict) assert.ok(hub.toolRejections() > 0, 'the real CLI must ask and the gateway must reject the valid shell call');
        assert.ok(captures.length > 0, 'the real CLI must dispatch to the local provider');
        assert.deepEqual(unexpectedRequests, [], 'no unobserved auxiliary provider endpoint may be contacted');
        assert.ok(captures.every((body) => body.model === 'dummy'), 'the exact requested model must be used');
        const summary = captures.map((body) => {
            const text = JSON.stringify(body.messages || []);
            return {
                conversationalIdentity: text.includes('You are a conversational assistant.'),
                clientInstruction: text.includes('synthetic-client-system'),
                workspaceContext: text.includes(dirs.workspace) || text.includes(dirs.workspace.replaceAll('\\', '\\\\')),
                environmentContext: /Working directory|workspace root|<environment|<env>|Platform:/i.test(text),
                privatePaths: Object.values(dirs).some((directory) => JSON.stringify(body).includes(JSON.stringify(directory).slice(1, -1))),
                tools: (body.tools || []).map((tool) => tool.function?.name || tool.name),
            };
        });
        const gatewayVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
        console.log(JSON.stringify({ gateway: `${gatewayVersion} working tree`, cli: health.version, profile: strict ? 'chat' : 'compatible', provider: 'local synthetic capture/dummy', toolAttempt, succeeded, rejected: hub.toolRejections(), requests: summary }, null, 2));
        assert.ok(summary.some((entry) => entry.conversationalIdentity), 'verify the custom agent was applied');
        assert.ok(summary.some((entry) => entry.clientInstruction), 'preserve the caller system instruction');
        if (strict) {
            assert.equal(captures.length, 1, 'one client request produces only one provider request');
            assert.ok(summary.every((entry) => !entry.workspaceContext && !entry.environmentContext && !entry.privatePaths && entry.tools.length === 0), 'strict profile omits host context and tools');
            const messages = captures[0].messages;
            assert.deepEqual(messages.map((message) => message.role), ['system', 'user']);
            const text = (content) => typeof content === 'string' ? content : content.map((part) => part.text).join('');
            assert.equal(text(messages[0].content), `${CHAT_SYSTEM}\nClient instruction marker: synthetic-client-system.`);
            assert.equal(text(messages[1].content), 'Say hello.');
        } else assert.ok(summary.some((entry) => entry.workspaceContext || entry.environmentContext), 'custom agent alone still carries backend context');
        assert.ok(summary.every((entry) => !entry.tools.includes('execute') && !entry.tools.includes('browser')), 'session denial removes execute/browser');
    } finally { await client.deleteSession(session.id).catch(() => {}); }
} finally {
    await hub?.stop();
    if (proc && proc.exitCode === null) {
        const exited = once(proc, 'exit');
        proc.kill();
        await exited;
    }
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    removeIsolatedRoot(dirs.root);
}
