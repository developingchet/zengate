// Property-based tests (fast-check): each property runs against many
// generated inputs instead of a few hand-picked examples.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { createStopFilter } from '../src/openai/stop.js';
import { isBlockedAddress } from '../src/openai/url-guard.js';
import { corsMiddleware } from '../src/server/cors.js';
import { fakeReq, run } from './helpers/fake-http.mjs';

const RUNS = { numRuns: 500 };

/** Split `text` at the given cut points (unsorted, possibly out of range). */
function chunk(text, cuts) {
    const points = [...new Set(cuts.map((c) => c % (text.length + 1)))].sort((a, b) => a - b);
    const bounds = [0, ...points, text.length];
    return bounds.slice(1).map((end, i) => text.slice(bounds[i], end));
}

function expectedStop(text, stops) {
    const hits = stops.filter(Boolean).map((s) => text.indexOf(s)).filter((i) => i >= 0);
    return hits.length ? text.slice(0, Math.min(...hits)) : text;
}

describe('createStopFilter (property)', () => {
    it('streams exactly the text before the first stop sequence, however it is chunked', () => {
        const alphabet = fc.constantFrom('a', 'b', 'c', '\n', 'é');
        const text = fc.string({ unit: alphabet, maxLength: 60 });
        const stops = fc.array(fc.string({ unit: alphabet, maxLength: 4 }), { maxLength: 4 });
        fc.assert(fc.property(text, stops, fc.array(fc.nat(), { maxLength: 8 }), (t, s, cuts) => {
            const filter = createStopFilter(s);
            const out = chunk(t, cuts).map((part) => filter.push(part)).join('') + filter.flush();
            assert.equal(out, expectedStop(t, s));
        }), RUNS);
    });
});

const octet = fc.integer({ min: 0, max: 255 });
const ipv4In = (a, b) => fc.tuple(octet, octet, octet)
    .map(([x, y, z]) => (b === undefined ? `${a}.${x}.${y}.${z}` : `${a}.${b}.${y}.${z}`));

describe('isBlockedAddress (property)', () => {
    const privateV4 = fc.oneof(
        ipv4In(10), ipv4In(127), ipv4In(192, 168), ipv4In(169, 254),
        fc.tuple(fc.integer({ min: 16, max: 31 }), octet, octet).map(([b, y, z]) => `172.${b}.${y}.${z}`),
        fc.tuple(fc.integer({ min: 64, max: 127 }), octet, octet).map(([b, y, z]) => `100.${b}.${y}.${z}`),
    );

    it('blocks every private, loopback, link-local and CGNAT IPv4 address', () => {
        fc.assert(fc.property(privateV4, (ip) => assert.equal(isBlockedAddress(ip), true)), RUNS);
    });

    it('blocks the same addresses written as IPv4-mapped IPv6', () => {
        fc.assert(fc.property(privateV4, fc.boolean(), (ip, upper) => {
            assert.equal(isBlockedAddress(`${upper ? '::FFFF' : '::ffff'}:${ip}`), true);
        }), RUNS);
    });

    it('blocks anything that is not an IP address', () => {
        const notIp = fc.string({ maxLength: 40 }).filter((s) => !/^[\d.:a-fA-F]+$/.test(s));
        fc.assert(fc.property(notIp, (value) => assert.equal(isBlockedAddress(value), true)), RUNS);
    });
});

describe('corsMiddleware (property)', () => {
    const ALLOWED = 'https://app.example';
    const cors = corsMiddleware({ origins: [ALLOWED], exposedHeaders: ['x-request-id'], maxAge: 600 });

    it('never grants CORS to an origin outside the allowlist', () => {
        const origin = fc.webUrl().filter((url) => url !== ALLOWED);
        fc.assert(fc.property(origin, fc.boolean(), (o, isPreflight) => {
            const headers = isPreflight
                ? { origin: o, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }
                : { origin: o };
            const { res } = run(cors, fakeReq({ method: isPreflight ? 'OPTIONS' : 'POST', headers }));
            assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
            assert.equal(res.headers['Access-Control-Allow-Headers'], undefined);
        }), RUNS);
    });

    it('only reflects requested headers that are a plain token list', () => {
        fc.assert(fc.property(fc.string({ maxLength: 60 }), (requested) => {
            const req = fakeReq({
                method: 'OPTIONS',
                headers: { origin: ALLOWED, 'access-control-request-method': 'POST', 'access-control-request-headers': requested },
            });
            const allowed = run(cors, req).res.headers['Access-Control-Allow-Headers'];
            if (allowed !== undefined) {
                assert.equal(allowed, requested.trim());
                // Commas separate tokens; everything else outside RFC 9110 tchar is refused.
                assert.doesNotMatch(allowed, /[\r\n\0"()/:;<=>?@[\\\]{}]/);
            }
        }), RUNS);
    });
});
