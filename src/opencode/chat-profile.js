import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export { CHAT_AGENT, CHAT_PLUGIN_ID } from './chat-plugin.js';

/** Install only our self-contained plugin into the private managed root. */
export function installChatProfile(dirs) {
    const directory = path.join(dirs.config, 'zengate-chat-plugin');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'zengate-chat-plugin', type: 'module', main: './index.js' }), { mode: 0o600 });
    fs.copyFileSync(new URL('./chat-plugin.js', import.meta.url), path.join(directory, 'index.js'));
    return {
        autoupdate: false,
        plugins: [pathToFileURL(directory).href],
        default_agent: 'zengate-chat',
        permissions: [{ action: '*', resource: '*', effect: 'deny' }],
        compaction: { auto: false },
    };
}
