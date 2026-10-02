import dns from 'node:dns/promises';
import net from 'node:net';
import { invalidRequest } from '../server/errors.js';

/**
 * Attachment URLs are fetched by the gateway, so a client could otherwise
 * point them at internal services (SSRF). Only public addresses are allowed;
 * this blocks loopback, private, link-local, CGNAT, multicast and other
 * special-purpose ranges, including IPv6 forms that embed an IPv4 address.
 */
const BLOCKED_V4 = new net.BlockList();
[
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([address, prefix]) => BLOCKED_V4.addSubnet(address, prefix, 'ipv4'));

const BLOCKED_V6 = new net.BlockList();
[
    // ::/96 also covers the deprecated IPv4-compatible form (::a.b.c.d).
    ['::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
    ['2002::', 16], ['3fff::', 20], ['5f00::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
].forEach(([address, prefix]) => BLOCKED_V6.addSubnet(address, prefix, 'ipv6'));

const LOOKUP_TIMEOUT_MS = 5000;
/** Most attachments one request may send as URLs. */
export const MAX_REMOTE_PARTS = 16;

/** The eight 16-bit groups of a valid IPv6 address (which may end in dotted IPv4). */
function ipv6Groups(address) {
    let text = address.toLowerCase();
    const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (dotted) {
        const [a, b, c, d] = dotted[1].split('.').map(Number);
        text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    }
    const [head, tail] = text.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const fill = text.includes('::') ? 8 - left.length - right.length : 0;
    return [...left, ...Array(fill).fill('0'), ...right].map((group) => parseInt(group, 16));
}

/**
 * The IPv4 address inside an IPv4-mapped (::ffff:0:0/96), IPv4-translated
 * (::ffff:0:0:0/96) or NAT64 well-known-prefix (64:ff9b::/96) address.
 */
function embeddedIpv4(groups) {
    const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
    const translated = groups.slice(0, 4).every((g) => g === 0) && groups[4] === 0xffff && groups[5] === 0;
    const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0);
    if (!mapped && !translated && !nat64) return null;
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
}

export function isBlockedAddress(address) {
    const plain = String(address).replace(/%.*$/, '');
    const family = net.isIP(plain);
    if (family === 4) return BLOCKED_V4.check(plain, 'ipv4');
    if (family !== 6) return true;
    const v4 = embeddedIpv4(ipv6Groups(plain));
    return v4 ? BLOCKED_V4.check(v4, 'ipv4') : BLOCKED_V6.check(plain, 'ipv6');
}

async function resolve(hostname) {
    const literal = hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(literal)) return [{ address: literal, family: net.isIP(literal) }];
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS lookup timed out')), LOOKUP_TIMEOUT_MS);
        timer.unref();
    });
    try {
        return await Promise.race([dns.lookup(literal, { all: true, verbatim: true }), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Every address `hostname` resolves to, provided all of them are public.
 * @param {string} hostname
 * @param {(address: string) => boolean} [isBlocked]
 * @returns {Promise<{ address: string, family: number }[]>}
 */
export async function resolvePublic(hostname, isBlocked = isBlockedAddress) {
    // One message for both failures, so clients cannot probe which internal names exist.
    const records = await resolve(hostname).catch(() => []);
    if (!records.length || records.some((record) => isBlocked(record.address))) {
        throw invalidRequest(`Attachment host '${hostname}' is not a public address.`, null, 'invalid_attachment_url');
    }
    return records;
}

/**
 * A `lookup` for http(s).request that only ever connects to the addresses it
 * has just checked, so DNS rebinding between check and connect cannot reach
 * an internal address.
 * @param {(address: string) => boolean} [isBlocked]
 */
export function publicLookup(isBlocked = isBlockedAddress) {
    return (hostname, options, callback) => {
        resolvePublic(hostname, isBlocked).then((records) => {
            const wanted = options?.family ? records.filter((record) => record.family === options.family) : records;
            if (!wanted.length) {
                callback(Object.assign(new Error(`No IPv${options.family} address for ${hostname}`), { code: 'ENOTFOUND' }));
            } else if (options?.all) {
                callback(null, wanted);
            } else {
                callback(null, wanted[0].address, wanted[0].family);
            }
        }, callback);
    };
}

/**
 * Reject prompt parts whose https URL resolves to a non-public address. This
 * is a fast early check; the fetch itself re-checks through publicLookup.
 * @param {{ url?: string }[]} parts OpenCode prompt parts
 */
export async function assertPublicUrls(parts) {
    const remote = parts.filter((part) => typeof part.url === 'string' && part.url.startsWith('https:'));
    // Checked before resolving anything, so one request cannot queue thousands of DNS lookups.
    if (remote.length > MAX_REMOTE_PARTS) {
        throw invalidRequest(`At most ${MAX_REMOTE_PARTS} attachments may be URLs; send the rest as data URIs.`, null, 'too_many_attachment_urls');
    }
    const hosts = new Set(remote.map((part) => new URL(part.url).hostname));
    await Promise.all([...hosts].map((hostname) => resolvePublic(hostname)));
}
