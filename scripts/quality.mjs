import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const ignoredDirectories = new Set(['.git', 'node_modules']);
const artifactExtensions = /\.(log|tmp|temp|bak|orig|rej|swp|swo|pid|out|err|zip|tgz|whl|deb|rpm|jar)$/i;
const artifactDirectories = new Set(['coverage', '.nyc_output', 'dist', 'build', 'out', 'reports', 'test-results', 'playwright-report', 'htmlcov', 'scratch', 'reviews', 'audits', 'planning']);
const sourceExtensions = new Set(['.js', '.mjs']);
const textExtensions = new Set(['.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.service', '.example', '.txt']);
const forbiddenPatterns = [
    new RegExp(['generated', 'by', 'ai'].join('\\s+'), 'i'),
    new RegExp(['created', 'by', 'ai'].join('\\s+'), 'i'),
    new RegExp(['assistant', 'worked'].join('\\s+'), 'i'),
    new RegExp(['opencode', 'proxy', 'jail'].join('-'), 'i'),
    new RegExp(`\\b${['TO', 'DO'].join('')}\\b`),
    new RegExp(`\\b${['FIX', 'ME'].join('')}\\b`)
];
const MAX_SOURCE_LINES = 800;
const failures = [];
const files = [];

function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.name !== '.github') {
            if (entry.isDirectory()) continue;
        }
        const fullPath = path.join(directory, entry.name);
        const relativePath = path.relative(root, fullPath);
        if (entry.isDirectory()) {
            if (ignoredDirectories.has(entry.name) || artifactDirectories.has(entry.name)) {
                if (!ignoredDirectories.has(entry.name)) failures.push(`artifact directory: ${relativePath}`);
                continue;
            }
            visit(fullPath);
            continue;
        }
        if (artifactExtensions.test(entry.name)) failures.push(`artifact file: ${relativePath}`);
        files.push({ fullPath, relativePath });
    }
}

visit(root);
for (const file of files) {
    const extension = path.extname(file.fullPath).toLowerCase();
    if (sourceExtensions.has(extension)) {
        const result = spawnSync(process.execPath, ['--check', file.fullPath], { encoding: 'utf8' });
        if (result.status !== 0) failures.push(`syntax error: ${file.relativePath}\n${result.stderr || result.stdout}`);
        const lines = fs.readFileSync(file.fullPath, 'utf8').split('\n').length;
        if (lines > MAX_SOURCE_LINES) failures.push(`${file.relativePath} has ${lines} lines (max ${MAX_SOURCE_LINES}); split it up`);
    }
    if (!textExtensions.has(extension)) continue;
    const content = fs.readFileSync(file.fullPath, 'utf8');
    for (const pattern of forbiddenPatterns) {
        if (pattern.test(content)) failures.push(`forbidden marker in ${file.relativePath}: ${pattern}`);
    }
}

if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
} else {
    console.log(`quality: ${files.length} project files checked`);
}
