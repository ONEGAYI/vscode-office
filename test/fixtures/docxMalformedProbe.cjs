const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { transformSync } = require('esbuild');

const source = fs.readFileSync(path.join(__dirname, '../../src/service/markdown/html-export.js'), 'utf8');
const code = transformSync(source, { loader: 'js', format: 'cjs' }).code;
const moduleRef = { exports: {} };
const packagedRequire = createRequire(path.join(__dirname, '../../out/extension.js'));
const resolveConverter = process.argv.includes('--packaged') ? packagedRequire.resolve : require.resolve;
new Function('require', 'module', 'exports', '__dirname', code)(
    Object.assign(name => name === './outline' ? { createOutline: async data => data } : require(name), { resolve: resolveConverter }),
    moduleRef, moduleRef.exports, path.join(__dirname, '../../out'),
);

const normal = process.argv.includes('--normal');
const malformed = Buffer.from('69636e73000000106963303700000000', 'hex').toString('base64');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';
const html = normal
    ? `<html><body><img src="data:image/png;base64,${png}"></body></html>`
    : `<html><body><img src="data:image/icns;base64,${malformed}"></body></html>`;
const output = path.join(os.tmpdir(), 'vscode-office-docx-worker-probe.docx');
moduleRef.exports.exportDocx(output, html, {})
    .then(() => {
        if (!normal) {
            console.error('unexpected success');
            process.exitCode = 1;
        } else {
            const size = fs.statSync(output).size;
            fs.unlinkSync(output);
            if (size < 100) process.exitCode = 1;
            else console.log('CONVERTED', size);
        }
    })
    .catch(error => {
        if (normal) {
            console.error(error);
            process.exitCode = 1;
        } else {
            console.log('ISOLATED_ERROR', error.message);
        }
    });
