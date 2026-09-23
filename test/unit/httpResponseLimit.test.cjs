const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { resolve } = require('node:path');
const { runInNewContext } = require('node:vm');

const code = buildSync({
    entryPoints: [resolve(__dirname, '../../src/provider/http/utils/httpClient.ts')],
    platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;

function clientFor(response, maxResponseSizeMB = 32) {
    const moduleRef = { exports: {} };
    class Request {
        constructor(method, url, headers = {}) {
            Object.assign(this, { method, url, headers, isCancelled: false });
        }
    }
    const mocks = {
        https: require('node:https'),
        '../models/configurationSettings': { RestClientSettings: { Instance: { followRedirect: true, decodeEscapedUnicodeCharacters: false, maxResponseSizeMB } } },
        '../models/httpRequest': { HttpRequest: Request },
        '../models/httpResponse': { HttpResponse: class {} },
        './mimeUtility': { MimeUtility: { parse: () => ({ charset: 'utf-8' }), decodeBuffer: b => b.toString() } },
        './misc': { encodeUrl: url => url, getHeader: () => undefined, removeHeader() {} },
        './streamUtility': { convertBufferToStream() {}, convertStreamToBuffer() {} },
    };
    runInNewContext(code, {
        module: moduleRef, exports: moduleRef.exports,
        require: name => mocks[name],
        fetch: async () => response,
        Buffer, Date, ReadableStream, AbortController,
    });
    return { client: new moduleRef.exports.HttpClient(), request: new Request('GET', 'https://example.test/') };
}

test('REST client rejects a large streaming response before retaining it', async () => {
    let cancelled = false;
    let sent = 0;
    const body = new ReadableStream({
        pull(controller) {
            if (sent++ === 5) return controller.close();
            controller.enqueue(new Uint8Array(9 * 1024 * 1024));
        },
        cancel() { cancelled = true; },
    });
    const { client, request } = clientFor({
        body, headers: new Headers(), status: 200, statusText: 'OK',
    });
    await assert.rejects(client.send(request), /response.*limit|limit.*response/i);
    assert.equal(cancelled, true);
});

test('REST client accepts a larger response when the user raises the limit', async () => {
    let sent = 0;
    const body = new ReadableStream({
        pull(controller) {
            if (sent++ === 4) return controller.close();
            controller.enqueue(new Uint8Array(9 * 1024 * 1024));
        },
    });
    const { client, request } = clientFor({
        body, headers: new Headers(), status: 200, statusText: 'OK',
    }, 64);
    await client.send(request);
});
