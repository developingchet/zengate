import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStopFilter } from '../src/openai/stop.js';
import { audioFromBase64, fileAttachment, imageFromUrl, kindForMime, videoFromUrl } from '../src/openai/media.js';

describe('stop filter', () => {
    it('passes text straight through without stop sequences', () => {
        const filter = createStopFilter([]);
        assert.equal(filter.push('hello'), 'hello');
        assert.equal(filter.push(''), '');
        assert.equal(filter.flush(), '');
        assert.equal(filter.stopped, false);
    });

    it('cuts at a stop sequence split across chunks', () => {
        const filter = createStopFilter(['STOP']);
        const out = [filter.push('Hello ST'), filter.push('OP world')];
        assert.equal(out.join(''), 'Hello ');
        assert.equal(filter.stopped, true);
        assert.equal(filter.push('more'), '');
        assert.equal(filter.flush(), '');
    });

    it('holds back only a possible stop prefix and releases it on flush', () => {
        const filter = createStopFilter(['###']);
        assert.equal(filter.push('abc#'), 'abc');
        assert.equal(filter.push('#'), '');
        assert.equal(filter.flush(), '##');
        assert.equal(filter.stopped, false);
    });

    it('waits for a longer sequence that starts before a shorter match', () => {
        const filter = createStopFilter(['abb', 'b']);
        assert.equal(filter.push('ab'), '');
        assert.equal(filter.stopped, false);
        assert.equal(filter.push('b'), '');
        assert.equal(filter.stopped, true);
    });

    it('applies the shorter match on flush when the longer sequence never completes', () => {
        const filter = createStopFilter(['abb', 'b']);
        assert.equal(filter.push('ab'), '');
        assert.equal(filter.flush(), 'a');
    });

    it('stops at the earliest of several sequences', () => {
        const filter = createStopFilter(['world', 'lo', '']);
        assert.equal(filter.push('hello world'), 'hel');
        assert.equal(filter.stopped, true);
    });

    it('stops at a sequence at the very start', () => {
        const filter = createStopFilter(['x']);
        assert.equal(filter.push('xyz'), '');
        assert.equal(filter.stopped, true);
    });
});

const MB = 1024 * 1024;
const opts = { maxBytes: MB, param: 'p' };
const b64 = (text) => Buffer.from(text).toString('base64');
const PNG = `data:image/png;base64,${b64('fake-png-bytes')}`;

function rejects(fn, { status = 400, code, message } = {}) {
    assert.throws(fn, (error) => {
        assert.equal(error.status, status);
        if (code !== undefined) assert.equal(error.code, code);
        if (message) assert.match(error.message, message);
        assert.equal(error.param, 'p');
        return true;
    });
}

describe('media', () => {
    it('classifies mime types', () => {
        assert.equal(kindForMime('image/png'), 'image');
        assert.equal(kindForMime('audio/wav'), 'audio');
        assert.equal(kindForMime('video/mp4'), 'video');
        assert.equal(kindForMime('application/pdf'), 'pdf');
        assert.equal(kindForMime('text/plain'), 'text');
        assert.equal(kindForMime('application/json'), 'text');
        assert.equal(kindForMime('application/zip'), null);
    });

    it('accepts image data URIs and normalizes image/jpg', () => {
        assert.deepEqual(imageFromUrl(PNG, opts), { kind: 'image', mime: 'image/png', url: PNG, filename: undefined });
        const jpg = `data:image/jpg;base64,${b64('x')}`;
        assert.equal(imageFromUrl(jpg, opts).mime, 'image/jpeg');
        const withParams = `data:image/png;name=a.png;base64,${b64('x')}`;
        assert.equal(imageFromUrl(withParams, opts).kind, 'image');
    });

    it('accepts https image URLs and guesses the type from the extension', () => {
        assert.deepEqual(imageFromUrl('https://example.com/cat.PNG?x=1', opts), { kind: 'image', mime: 'image/png', url: 'https://example.com/cat.PNG?x=1', filename: undefined });
        assert.equal(imageFromUrl('https://example.com/cat', opts).mime, 'image/*');
    });

    it('rejects svg, plain http, bad URIs and oversized data', () => {
        rejects(() => imageFromUrl(`data:image/svg+xml;base64,${b64('<svg/>')}`, opts), { code: 'unsupported_parameter', message: /SVG/ });
        rejects(() => imageFromUrl('http://example.com/a.png', opts), { message: /https/ });
        rejects(() => imageFromUrl('https://', opts), { message: /Invalid attachment URL/ });
        rejects(() => imageFromUrl(`https://example.com/${'a'.repeat(9000)}`, opts), { message: /longer than/ });
        rejects(() => imageFromUrl('data:image/png,notbase64', opts), { message: /base64 data URIs/ });
        rejects(() => imageFromUrl('', opts), { message: /image_url.url is required/ });
        rejects(() => imageFromUrl(undefined, opts), { message: /required/ });
        rejects(() => imageFromUrl(`data:audio/wav;base64,${b64('x')}`, opts), { message: /Expected image/ });
        rejects(() => imageFromUrl(`data:application/zip;base64,${b64('x')}`, opts), { code: 'unsupported_parameter' });
        const big = `data:image/png;base64,${'A'.repeat(2000)}`;
        rejects(() => imageFromUrl(big, { maxBytes: 1000, param: 'p' }), { code: 'attachment_too_large', message: /MAX_MEDIA_MB/ });
    });

    it('handles video URLs', () => {
        const mp4 = `data:video/mp4;base64,${b64('v')}`;
        assert.equal(videoFromUrl(mp4, opts).kind, 'video');
        assert.equal(videoFromUrl('https://example.com/clip.webm', opts).mime, 'video/webm');
        assert.equal(videoFromUrl('https://example.com/clip', opts).mime, 'video/*');
        rejects(() => videoFromUrl('', opts), { message: /video_url.url is required/ });
    });

    it('handles input_audio base64 and data URIs', () => {
        const audio = audioFromBase64(b64('wav'), 'WAV', opts);
        assert.equal(audio.kind, 'audio');
        assert.equal(audio.mime, 'audio/wav');
        assert.ok(audio.url.startsWith('data:audio/wav;base64,'));
        assert.equal(audioFromBase64(`data:audio/mpeg;base64,${b64('m')}`, 'mp3', opts).mime, 'audio/mpeg');
        rejects(() => audioFromBase64(b64('x'), 'aiff', opts), { message: /format must be one of/ });
        rejects(() => audioFromBase64('', 'wav', opts), { message: /data \(base64\) is required/ });
    });

    it('inlines text files and attaches binary ones', () => {
        const text = fileAttachment({ file_data: `data:text/plain;base64,${b64('hello file')}`, filename: 'notes.txt' }, opts);
        assert.deepEqual(text, { kind: 'text', mime: 'text/plain', filename: 'notes.txt', text: 'hello file' });
        const bare = fileAttachment({ file_data: b64('{"a":1}'), filename: 'data.json' }, opts);
        assert.equal(bare.kind, 'text');
        assert.equal(bare.text, '{"a":1}');
        const pdf = fileAttachment({ file_data: b64('%PDF'), filename: 'doc.pdf' }, opts);
        assert.equal(pdf.kind, 'pdf');
        assert.ok(pdf.url.startsWith('data:application/pdf;base64,'));
        const remote = fileAttachment({ file_url: 'https://example.com/report.pdf', filename: 'report.pdf' }, opts);
        assert.deepEqual(remote, { kind: 'pdf', mime: 'application/pdf', url: 'https://example.com/report.pdf', filename: 'report.pdf' });
        assert.equal(fileAttachment({ file_url: 'https://example.com/pic.png' }, opts).kind, 'image');
        assert.equal(fileAttachment({ file_url: 'https://example.com/archive.zip' }, opts).kind, 'pdf');
        assert.equal(fileAttachment({ file_data: `data:text/plain;base64,${b64('x')}`, filename: `${'n'.repeat(300)}.txt` }, opts).filename.length, 255);
    });

    it('rejects file_id and incomplete file parts', () => {
        rejects(() => fileAttachment({ file_id: 'file-123' }, opts), { code: 'unsupported_parameter', message: /Files API/ });
        rejects(() => fileAttachment({}, opts), { message: /file_data is required/ });
        rejects(() => fileAttachment({ file_data: b64('x') }, opts), { message: /include a filename/ });
        rejects(() => fileAttachment({ file_data: b64('x'), filename: 'blob.unknownext' }, opts), { message: /include a filename/ });
    });
});
