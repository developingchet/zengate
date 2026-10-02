import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { assertPublicUrls, isBlockedAddress } from '../src/openai/url-guard.js';

const part = (url) => ({ type: 'file', mime: 'image/png', url });

async function rejected(url, pattern = /not a public address/) {
    await assert.rejects(assertPublicUrls([part(url)]), (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.code, 'invalid_attachment_url');
        assert.match(error.message, pattern);
        return true;
    }, url);
}

describe('isBlockedAddress', () => {
    it('blocks loopback, private, link-local and special ranges', () => {
        for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
            '224.0.0.1', '198.18.0.1', '203.0.113.9', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::3', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
            assert.equal(isBlockedAddress(ip), true, ip);
        }
    });

    it('blocks IPv6 forms that carry an internal IPv4 address or tunnel to one', () => {
        for (const ip of ['::ffff:7f00:1', '::ffff:0:7f00:1', '::7f00:1', '::127.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::',
            '2001:0:4136:e378::1', '2001:db8::1', '3fff::1', 'fec0::1', 'fe80::1%eth0', '192.88.99.1']) {
            assert.equal(isBlockedAddress(ip), true, ip);
        }
    });

    it('allows public addresses and rejects non-IPs', () => {
        for (const ip of ['93.184.215.14', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808']) {
            assert.equal(isBlockedAddress(ip), false, ip);
        }
        assert.equal(isBlockedAddress('example.com'), true);
        assert.equal(isBlockedAddress(''), true);
    });
});

describe('assertPublicUrls', () => {
    it('rejects attachment URLs pointing at internal addresses', async () => {
        for (const url of ['https://127.0.0.1/x.png', 'https://[::1]/a', 'https://10.1.2.3/a', 'https://169.254.169.254/latest/meta-data', 'https://[::ffff:192.168.0.1]/a']) {
            await rejected(url);
        }
    });

    it('limits the number of URL attachments before resolving any of them', async (t) => {
        const lookup = t.mock.method(dns, 'lookup', async () => [{ address: '93.184.215.14', family: 4 }]);
        const parts = Array.from({ length: 17 }, (_, i) => part(`https://host${i}.example/a.png`));
        await assert.rejects(assertPublicUrls(parts), { status: 400, code: 'too_many_attachment_urls' });
        assert.equal(lookup.mock.callCount(), 0);
    });

    it('rejects hostnames resolving to loopback', async () => {
        await rejected('https://localhost/a.png');
    });

    it('accepts public literals and ignores parts without https URLs', async () => {
        await assertPublicUrls([
            part('https://93.184.215.14/a.png'),
            part('https://93.184.215.14/b.png'),
            part('data:image/png;base64,AAAA'),
            { type: 'text', text: 'hello' },
            part(undefined),
        ]);
        await assertPublicUrls([]);
    });

    it('checks every resolved address of a hostname (lookup mocked)', async (t) => {
        const answers = {
            'public.example': [{ address: '93.184.215.14', family: 4 }],
            'mixed.example': [{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.8', family: 4 }],
            'empty.example': [],
        };
        t.mock.method(dns, 'lookup', async (host) => {
            if (host in answers) return answers[host];
            throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
        });
        await assertPublicUrls([part('https://public.example/a.png')]);
        await rejected('https://mixed.example/a.png');
        await rejected('https://empty.example/a.png');
        await rejected('https://name.invalid/a.png', /Could not resolve attachment host 'name.invalid'/);
    });
});
