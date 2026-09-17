import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveWebviewContent } from '../../src/common/webviewContent.ts';

describe('resolveWebviewContent', () => {
    it('uses the dev server content in dev mode when reachable', async () => {
        let prodCalls = 0;
        const result = await resolveWebviewContent({
            isDev: true,
            fetchDev: async () => '<html>dev</html>',
            readProd: () => { prodCalls += 1; return '<html>prod</html>'; },
        });
        assert.equal(result.html, '<html>dev</html>');
        assert.equal(result.fromDevServer, true);
        assert.equal(prodCalls, 0);
    });

    it('falls back to the production build when the dev server is unreachable', async () => {
        const result = await resolveWebviewContent({
            isDev: true,
            fetchDev: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:5739'); },
            readProd: async () => '<html>prod</html>',
        });
        assert.equal(result.html, '<html>prod</html>');
        assert.equal(result.fromDevServer, false);
    });

    it('does not contact the dev server outside dev mode', async () => {
        let devCalls = 0;
        const result = await resolveWebviewContent({
            isDev: false,
            fetchDev: () => { devCalls += 1; return Promise.resolve('<html>dev</html>'); },
            readProd: async () => '<html>prod</html>',
        });
        assert.equal(result.html, '<html>prod</html>');
        assert.equal(result.fromDevServer, false);
        assert.equal(devCalls, 0);
    });
});
