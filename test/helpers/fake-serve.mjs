/**
 * Stand-in for `opencode serve` used by the managed-backend tests. It answers
 * GET /global/health (with basic auth) and exits on GET /crash (no auth). With
 * --exit-immediately it exits at once, like a binary that fails to start.
 */
import http from 'node:http';

const args = process.argv.slice(2);
if (args.includes('--exit-immediately')) process.exit(3);

const port = Number(args[args.indexOf('--port') + 1]);
const announce = !args.includes('--never-listen');
const expected = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD || ''}`).toString('base64')}`;
process.stdout.write('\x1b[32mfake opencode starting\x1b[0m\npartial line without newline');
process.stderr.write('warning line\n\n');

http.createServer((req, res) => {
    if (req.url === '/crash') {
        res.writeHead(200).end('bye', () => process.exit(1));
        return;
    }
    if (req.headers.authorization !== expected) {
        res.writeHead(401).end();
        return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ healthy: true, version: '7.7.7-fake' }));
}).listen(port, '127.0.0.1', function announcePort() {
    // Like OpenCode, report the port actually bound (--port 0 picks one).
    if (announce) process.stdout.write(`\x1b[1mopencode server listening on http://127.0.0.1:${this.address().port}\x1b[0m\n`);
});
