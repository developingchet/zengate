import dns from 'node:dns/promises';
import net from 'node:net';
import { invalidRequest } from '../server/errors.js';

/**
 * Attachment URLs are fetched by OpenCode on this host, so a client could
 * otherwise point them at internal services (SSRF). Only public addresses
 * are allowed; this blocks loopback, private, link-local, CGNAT, multicast
 * and other special-purpose ranges.
 */
const BLOCKED = new net.BlockList();
[
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([address, prefix]) => BLOCKED.addSubnet(address, prefix, 'ipv4'));
[
    ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
].forEach(([address, prefix]) => BLOCKED.addSubnet(address, prefix, 'ipv6'));

const LOOKUP_TIMEOUT_MS = 5000;

export function isBlockedAddress(address) {
    const family = net.isIP(address);
    if (family === 0) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return BLOCKED.check(mapped[1], 'ipv4');
    return BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

async function resolve(hostname) {
    const literal = hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(literal)) return [literal];
    const lookup = dns.lookup(literal, { all: true, verbatim: true });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('DNS lookup timed out')), LOOKUP_TIMEOUT_MS).unref());
    const records = await Promise.race([lookup, timeout]);
    return records.map((record) => record.address);
}

/**
 * Reject prompt parts whose https URL resolves to a non-public address.
 * @param {{ url?: string }[]} parts OpenCode prompt parts
 */
export async function assertPublicUrls(parts) {
    const hosts = new Set();
    for (const part of parts) {
        if (typeof part.url !== 'string' || !part.url.startsWith('https:')) continue;
        hosts.add(new URL(part.url).hostname);
    }
    await Promise.all([...hosts].map(async (hostname) => {
        let addresses;
        try {
            addresses = await resolve(hostname);
        } catch {
            throw invalidRequest(`Could not resolve attachment host '${hostname}'.`, null, 'invalid_attachment_url');
        }
        if (!addresses.length || addresses.some(isBlockedAddress)) {
            throw invalidRequest(`Attachment host '${hostname}' is not a public address.`, null, 'invalid_attachment_url');
        }
    }));
}
