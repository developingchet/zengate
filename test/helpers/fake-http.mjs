import { EventEmitter } from 'node:events';

/** Minimal Express-like response double for middleware unit tests. */
export function fakeRes() {
    const res = new EventEmitter();
    Object.assign(res, {
        headers: {},
        statusCode: 200,
        body: undefined,
        writableFinished: false,
        set(name, value) {
            if (typeof name === 'object') Object.assign(this.headers, name);
            else this.headers[name] = value;
            return this;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    });
    return res;
}

export function fakeReq({ path = '/v1/models', method = 'GET', headers = {}, ip = '127.0.0.1' } = {}) {
    return { path, method, headers, ip, socket: { remoteAddress: ip } };
}

/** Run a middleware and report whether it called next(). */
export function run(middleware, req, res = fakeRes()) {
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    return { res, nextCalled };
}
