import net from 'node:net';

const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** The first four groups (the /64 network) of an IPv6 address, normalized. */
function network64(address) {
    const plain = address.split('%')[0].toLowerCase();
    const [head, tail = ''] = plain.split('::');
    const left = head ? head.split(':') : [];
    if (!plain.includes('::')) return left.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(':');
    const right = tail ? tail.split(':') : [];
    // An embedded IPv4 address fills the last two groups.
    const rightGroups = right.reduce((count, group) => count + (group.includes('.') ? 2 : 1), 0);
    const groups = [...left, ...Array(Math.max(0, 8 - left.length - rightGroups)).fill('0'), ...right];
    return groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(':');
}

/**
 * The key a client is rate limited by. An IPv6 client normally has a whole
 * /64 to pick addresses from, so IPv6 addresses count per /64 network;
 * IPv4-mapped IPv6 counts as the IPv4 address.
 * @param {{ ip?: string, socket?: { remoteAddress?: string } }} req
 */
export function clientKey(req) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (!net.isIPv6(ip)) return ip;
    const mapped = MAPPED_IPV4.exec(ip);
    return mapped ? mapped[1] : `${network64(ip)}::/64`;
}
