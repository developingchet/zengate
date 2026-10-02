const HEADER = 'x-gateway-ignored-params';
const MAX_LISTED = 32;
const LISTABLE = /^[\w.-]{1,64}$/;

/**
 * Report accepted-but-ignored request parameters in a response header.
 * The names come from the client's JSON keys, so only short header-safe
 * names are listed, and at most MAX_LISTED of them.
 * @param {import('express').Response} res
 * @param {string[]} ignored
 */
export function setIgnoredParams(res, ignored) {
    const listed = ignored.filter((name) => LISTABLE.test(name)).slice(0, MAX_LISTED);
    if (listed.length) res.set(HEADER, listed.join(','));
}
