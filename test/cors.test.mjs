import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { corsMiddleware } from '../src/server/cors.js';
import { fakeReq, run } from './helpers/fake-http.mjs';

const ALLOWED = 'https://app.example';
const cors = corsMiddleware({ origins: [ALLOWED, 'https://other.example'], exposedHeaders: ['x-request-id', 'Retry-After'], maxAge: 600 });

function preflight(origin, requestHeaders = 'authorization, content-type') {
    return fakeReq({
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': requestHeaders },
    });
}

describe('corsMiddleware', () => {
    it('allows a configured origin on normal requests and exposes gateway headers', () => {
        const { res, nextCalled } = run(cors, fakeReq({ headers: { origin: ALLOWED } }));
        assert.ok(nextCalled);
        assert.equal(res.headers['Access-Control-Allow-Origin'], ALLOWED);
        assert.equal(res.headers['Access-Control-Expose-Headers'], 'x-request-id,Retry-After');
        assert.equal(res.headers.Vary, 'Origin');
        assert.equal(res.headers['Access-Control-Allow-Credentials'], undefined, 'credentials are never allowed');
    });

    it('sends no CORS grant to other origins, but still varies on Origin', () => {
        const { res, nextCalled } = run(cors, fakeReq({ headers: { origin: 'https://evil.example' } }));
        assert.ok(nextCalled);
        assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
        assert.equal(res.headers['Access-Control-Expose-Headers'], undefined);
        assert.equal(res.headers.Vary, 'Origin');
    });

    it('matches origins exactly (no prefix, suffix or case tricks)', () => {
        for (const origin of [`${ALLOWED}.evil.example`, 'https://app.example:8443', 'HTTPS://APP.EXAMPLE', 'null']) {
            assert.equal(run(cors, fakeReq({ headers: { origin } })).res.headers['Access-Control-Allow-Origin'], undefined, origin);
        }
    });

    it('answers preflights with 204 and the allowed methods and headers', () => {
        const { res, nextCalled } = run(cors, preflight(ALLOWED));
        assert.equal(nextCalled, false);
        assert.equal(res.statusCode, 204);
        assert.ok(res.ended);
        assert.equal(res.headers['Access-Control-Allow-Origin'], ALLOWED);
        assert.equal(res.headers['Access-Control-Allow-Methods'], 'GET,HEAD,POST,DELETE,OPTIONS');
        assert.equal(res.headers['Access-Control-Allow-Headers'], 'authorization, content-type');
        assert.equal(res.headers['Access-Control-Max-Age'], '600');
        assert.equal(res.headers.Vary, 'Origin, Access-Control-Request-Headers');
    });

    it('answers preflights from other origins without granting access', () => {
        const { res, nextCalled } = run(cors, preflight('https://evil.example'));
        assert.equal(nextCalled, false);
        assert.equal(res.statusCode, 204);
        assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
        assert.equal(res.headers['Access-Control-Allow-Methods'], undefined);
    });

    it('does not reflect malformed request headers', () => {
        const { res } = run(cors, preflight(ALLOWED, 'x-ok, bad header\r\nset-cookie: a=b'));
        assert.equal(res.headers['Access-Control-Allow-Headers'], undefined);
    });

    it('passes plain OPTIONS requests (no preflight) and requests without Origin through', () => {
        assert.ok(run(cors, fakeReq({ method: 'OPTIONS', headers: { origin: ALLOWED } })).nextCalled);
        const { res, nextCalled } = run(cors, fakeReq());
        assert.ok(nextCalled);
        assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
    });
});
