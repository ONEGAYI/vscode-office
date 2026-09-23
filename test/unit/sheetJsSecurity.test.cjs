const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { resolve } = require('node:path');
const XLSX = require('xlsx');

test('SheetJS dependency includes the security fixes after 0.18.5', () => {
    const [major, minor] = XLSX.version.split('.').map(Number);
    assert.ok(major > 0 || minor >= 20, `outdated SheetJS ${XLSX.version}`);
});

test('XLS and ODS files still load through the office reader', async () => {
    const code = buildSync({
        entryPoints: [resolve(__dirname, '../../src/react/view/excel/excel_reader.ts')],
        bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    }).outputFiles[0].text;
    const moduleRef = { exports: {} };
    new Function('require', 'module', 'exports', code)(
        (name) => name === '@cweijan/exceljs' ? {} : require(name),
        moduleRef,
        moduleRef.exports,
    );
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Name', 'Value'], ['Test', 42]]), 'Sheet1');
    for (const [type, ext] of [['biff8', '.xls'], ['ods', '.ods']]) {
        const bytes = XLSX.write(workbook, { type: 'array', bookType: type });
        const result = await moduleRef.exports.loadSheets(bytes, ext);
        assert.equal(result.sheets[0].rows[1].cells[0].text, 'Test');
        assert.equal(result.sheets[0].rows[1].cells[1].text, '42');
    }
});
