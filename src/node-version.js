/**
 * Imported first by index.js, before any module that needs Node 24, so an
 * older runtime gets one clear message instead of an obscure failure later.
 */
const REQUIRED_MAJOR = 24;
const major = Number(process.versions.node.split('.')[0]);

if (major < REQUIRED_MAJOR) {
    process.stderr.write(`zengate needs Node.js ${REQUIRED_MAJOR} or newer; this is ${process.version}.\n`);
    process.exit(1);
}
