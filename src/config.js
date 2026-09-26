import fs from 'node:fs';

/**
 * Every setting can come from the environment or config.json (same key).
 * Environment wins. Values are validated up front so a typo fails at startup
 * with a clear message instead of silently falling back to a default.
 */
const SPEC = Object.freeze({
    PORT: { type: 'int', default: 8083, min: 1, max: 65535 },
    HOST: { type: 'string', default: '127.0.0.1' },
    API_KEY: { type: 'string', default: '', secret: true },
    API_KEYS: { type: 'list', default: [], secret: true },
    ALLOW_NO_AUTH: { type: 'bool', default: false },
    OPENCODE_PATH: { type: 'string', default: '' },
    OPENCODE_SERVER_URL: { type: 'string', default: '' },
    OPENCODE_SERVER_USERNAME: { type: 'string', default: 'opencode' },
    OPENCODE_SERVER_PASSWORD: { type: 'string', default: '', secret: true },
    ALLOW_INSECURE_BACKEND_HTTP: { type: 'bool', default: false },
    OPENCODE_AGENT: { type: 'string', default: 'plan' },
    MAX_CONCURRENT: { type: 'int', default: 8, min: 1, max: 64 },
    MAX_QUEUE: { type: 'int', default: 32, min: 0, max: 1000 },
    RATE_LIMIT_PER_MINUTE: { type: 'int', default: 120, min: 0, max: 100000 },
    REQUEST_TIMEOUT_MS: { type: 'int', default: 300000, min: 10000, max: 3600000 },
    MAX_BODY_MB: { type: 'int', default: 25, min: 1, max: 200 },
    MAX_MEDIA_MB: { type: 'int', default: 20, min: 1, max: 100 },
    RESPONSES_STORE_MAX: { type: 'int', default: 500, min: 0, max: 100000 },
    CORS_ORIGINS: { type: 'list', default: [] },
    TRUST_PROXY: { type: 'hops', default: 0 },
    LOG_LEVEL: { type: 'enum', default: 'info', values: ['debug', 'info', 'warn', 'error'] },
    LOG_JSON: { type: 'bool', default: false },
});

export const CONFIG_KEYS = Object.freeze(Object.keys(SPEC));

/** Keys that are too short or too well known to protect anything. */
const MIN_KEY_LENGTH = 16;
const PLACEHOLDER_KEYS = new Set(['change-me', 'changeme', 'your-secret-api-key', 'your-api-key', 'sk-xxxx']);

export class ConfigError extends Error {
    constructor(problems) {
        super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
        this.name = 'ConfigError';
        this.problems = problems;
    }
}

export function parseBool(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
    if (typeof value !== 'string') return undefined;
    const v = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    return undefined;
}

function parseValue(key, spec, raw) {
    switch (spec.type) {
        case 'string':
            return { value: String(raw).trim() };
        case 'bool': {
            const value = parseBool(raw);
            return value === undefined ? { error: `${key} must be true or false (got "${raw}")` } : { value };
        }
        case 'int': {
            const text = String(raw).trim();
            if (!/^-?\d+$/.test(text)) return { error: `${key} must be an integer (got "${raw}")` };
            const value = Number(text);
            if (value < spec.min || value > spec.max) {
                return { error: `${key} must be between ${spec.min} and ${spec.max} (got ${value})` };
            }
            return { value };
        }
        case 'list': {
            const items = Array.isArray(raw) ? raw : String(raw).split(',');
            return { value: [...new Set(items.map((item) => String(item).trim()).filter(Boolean))] };
        }
        case 'hops': {
            const bool = parseBool(raw);
            if (bool !== undefined) return { value: bool ? 1 : 0 };
            return parseValue(key, { type: 'int', min: 0, max: 10 }, raw);
        }
        case 'enum': {
            const value = String(raw).trim().toLowerCase();
            return spec.values.includes(value) ? { value } : { error: `${key} must be one of: ${spec.values.join(', ')}` };
        }
        default:
            return { error: `${key} has an unknown type` };
    }
}

/** Reads config.json. A missing file is fine; a malformed one is fatal. */
export function readConfigFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return {};
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new ConfigError([`${filePath} is not valid JSON: ${error.message}`]);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ConfigError([`${filePath} must contain a JSON object`]);
    }
    return parsed;
}

function validateKeys(keys, problems) {
    for (const key of keys) {
        if (PLACEHOLDER_KEYS.has(key.toLowerCase())) {
            problems.push('API_KEY is a placeholder value; run `npm run setup` or set a unique random key');
        } else if (key.length < MIN_KEY_LENGTH) {
            problems.push(`API_KEY must be at least ${MIN_KEY_LENGTH} characters (run \`npm run setup\` to generate one)`);
        }
    }
}

function validateServerUrl(config, problems) {
    if (!config.OPENCODE_SERVER_URL) return;
    let url;
    try {
        url = new URL(config.OPENCODE_SERVER_URL);
    } catch {
        problems.push('OPENCODE_SERVER_URL must be an absolute http(s) URL');
        return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        problems.push('OPENCODE_SERVER_URL must use http or https');
    } else if (url.protocol === 'http:' && !isLoopbackHost(url.hostname) && !config.ALLOW_INSECURE_BACKEND_HTTP) {
        problems.push('a remote OPENCODE_SERVER_URL must use https (or set ALLOW_INSECURE_BACKEND_HTTP=true on a trusted private network)');
    }
}

/**
 * Merge config.json and the environment into one validated, frozen config.
 * @param {Record<string, unknown>} fileConfig parsed config.json (may be empty)
 * @param {Record<string, string|undefined>} env usually process.env
 */
export function loadConfig(fileConfig = {}, env = process.env) {
    const problems = [];
    const unknown = Object.keys(fileConfig).filter((key) => !(key in SPEC) && key !== '$schema');
    if (unknown.length) problems.push(`unknown config.json keys: ${unknown.join(', ')}`);

    const parsed = {};
    for (const [key, spec] of Object.entries(SPEC)) {
        const raw = env[key] !== undefined && env[key] !== '' ? env[key] : fileConfig[key];
        if (raw === undefined || raw === null || raw === '') {
            parsed[key] = spec.default;
            continue;
        }
        const result = parseValue(key, spec, raw);
        if (result.error) problems.push(result.error);
        else parsed[key] = result.value;
    }

    const { API_KEY: primaryKey, ...rest } = parsed;
    const config = {
        ...rest,
        API_KEYS: [...new Set([primaryKey, ...(rest.API_KEYS || [])].filter(Boolean))],
        OPENCODE_SERVER_URL: String(rest.OPENCODE_SERVER_URL || '').replace(/\/+$/, ''),
    };
    if (config.CORS_ORIGINS?.includes('*')) {
        problems.push('CORS_ORIGINS must list explicit origins; "*" would let any website use the gateway');
    }
    if (!/^[\w.-]{1,64}$/.test(config.OPENCODE_AGENT || '')) {
        problems.push('OPENCODE_AGENT must be a simple agent name');
    }
    validateKeys(config.API_KEYS, problems);
    validateServerUrl(config, problems);
    if (problems.length) throw new ConfigError(problems);
    return Object.freeze(config);
}

/** True when the gateway must refuse to start: no key and no explicit opt-out. */
export function needsApiKey(config) {
    return config.API_KEYS.length === 0 && !config.ALLOW_NO_AUTH;
}

export function isLoopbackHost(host) {
    const raw = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    return raw === 'localhost' || raw === '::1' || /^127(\.\d{1,3}){3}$/.test(raw);
}

/** Config safe to print: secrets are reduced to a count or "set"/"unset". */
export function describeConfig(config) {
    const out = {};
    for (const [key, spec] of Object.entries(SPEC)) {
        if (key === 'API_KEY') continue;
        const value = config[key];
        if (!spec.secret) out[key] = value;
        else out[key] = Array.isArray(value) ? `${value.length} configured` : (value ? 'set' : 'unset');
    }
    return out;
}
