// Run in an isolated extension test host with --extensionTestsPath=<this file>.
// Set OFFICE_SWITCH_TEST_RESULT to receive the report outside the host process.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, description) {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await pause(50);
    }
    throw new Error('Timed out: ' + description);
}

exports.run = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-switch-test-'));
    const results = [];
    const report = process.env.OFFICE_SWITCH_TEST_RESULT || path.join(os.tmpdir(), 'office-switch-test-result.json');
    const original = vscode.Uri.file(path.join(dir, 'before.md'));
    const modified = vscode.Uri.file(path.join(dir, 'after.md'));
    const beforeText = '# Before\n原文\n';
    const afterText = '# After\n修改\n';
    const tab = () => vscode.window.tabGroups.activeTabGroup.activeTab;
    const snapshot = () => vscode.window.tabGroups.all.flatMap(g => g.tabs.map(t => ({
        label: t.label, active: t.isActive, input: t.input,
    })));
    try {
        fs.writeFileSync(original.fsPath, beforeText);
        fs.writeFileSync(modified.fsPath, afterText);
        const extension = vscode.extensions.all.find(e => e.packageJSON.name === 'vscode-office'
            && path.resolve(e.extensionPath).toLowerCase() === path.resolve(__dirname, '../..').toLowerCase());
        assert.ok(extension, 'must run in this extension test host');
        await extension.activate();

        // Explorer supplies the focused URI followed by the selected URIs.
        // Every tab opened by this command must be native from the outset.
        const opened = [];
        const listener = vscode.window.tabGroups.onDidChangeTabs(event => opened.push(...event.opened));
        try {
            await vscode.commands.executeCommand('office.markdown.compareSelected', original, [original, modified]);
            await until(() => tab()?.input instanceof vscode.TabInputTextDiff, 'direct native comparison');
            assert.equal(tab().input.original.toString(), original.toString());
            assert.equal(tab().input.modified.toString(), modified.toString());
            assert.ok(opened.length > 0);
            assert.ok(opened.every(t => t.input instanceof vscode.TabInputTextDiff), 'first view must be plain text');
            results.push({ scenario: 'Explorer comparison opens directly as text', passed: true });
        } finally {
            listener.dispose();
        }

        for (const scenario of [
            { name: 'left focus', side: 'First', uri: original },
            { name: 'right focus', side: 'Second', uri: modified },
            { name: 'closed source tabs', side: 'Second', uri: modified, closeSources: true },
            { name: 'no title URI and closed source tabs', side: 'Second', closeSources: true },
        ]) {
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            await vscode.commands.executeCommand('vscode.openWith', original, 'cweijan.markdownViewer');
            await vscode.commands.executeCommand('vscode.openWith', modified, 'cweijan.markdownViewer');
            await vscode.commands.executeCommand('vscode.diff', original, modified);
            // New VS Code builds already fall back to the native text diff.
            await until(() => tab()?.label === 'before.md ↔ after.md', 'comparison tab');
            const supportsEditorComparison = !tab().input;
            if (scenario.closeSources) {
                for (const group of vscode.window.tabGroups.all) {
                    for (const sourceTab of [...group.tabs]) {
                        if (sourceTab.input instanceof vscode.TabInputCustom) await vscode.window.tabGroups.close(sourceTab);
                    }
                }
            }
            await vscode.commands.executeCommand(`workbench.action.focus${scenario.side}SideEditor`);
            await vscode.commands.executeCommand('office.markdown.switch', scenario.uri);
            await until(() => tab()?.input instanceof vscode.TabInputTextDiff, 'native text diff');
            assert.equal(tab().input.original.toString(), original.toString());
            assert.equal(tab().input.modified.toString(), modified.toString());
            assert.equal(vscode.workspace.fs.isWritableFileSystem(tab().input.modified.scheme), true);
            const count = snapshot().length;
            await vscode.commands.executeCommand('office.markdown.switch', modified);
            await until(() => supportsEditorComparison ? tab() && !tab().input
                : tab()?.input instanceof vscode.TabInputTextDiff, 'second switch returns to editor comparison (or platform text fallback)');
            assert.equal(tab().label, 'before.md ↔ after.md');
            assert.equal(snapshot().length, count, 'switching must not accumulate comparison tabs');
            await vscode.commands.executeCommand('office.markdown.switch', scenario.uri);
            await until(() => tab()?.input instanceof vscode.TabInputTextDiff, 'third switch returns to text diff');
            assert.equal(tab().input.original.toString(), original.toString());
            assert.equal(tab().input.modified.toString(), modified.toString());
            assert.equal(snapshot().length, count);
            results.push({ scenario: scenario.name, passed: true });
        }

        // Use editor.edit (not a disk write) so a read-only editor would fail.
        const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === modified.toString());
        assert.ok(editor, 'modified text editor is visible');
        assert.equal(await editor.edit(edit => edit.insert(new vscode.Position(0, 0), 'saved from diff\n')), true);
        const draft = editor.document.getText();
        const draftTabCount = snapshot().length;
        await vscode.commands.executeCommand('office.markdown.switch', modified);
        assert.equal(editor.document.getText(), draft, 'switching to editors must retain the unsaved buffer');
        assert.equal(editor.document.isDirty, true);
        await vscode.commands.executeCommand('office.markdown.switch', modified);
        await until(() => tab()?.input instanceof vscode.TabInputTextDiff, 'unsaved draft returns to text diff');
        assert.equal(editor.document.getText(), draft);
        assert.ok(snapshot().length <= draftTabCount + 1, 'dirty round trips reuse the two views');
        assert.equal(fs.readFileSync(modified.fsPath, 'utf8'), afterText, 'switching must not silently save the draft');
        results.push({ scenario: 'unsaved draft survives a round trip', passed: true });
        assert.equal(await editor.document.save(), true);
        assert.equal(fs.readFileSync(modified.fsPath, 'utf8'), 'saved from diff\n' + afterText);
        assert.equal(fs.readFileSync(original.fsPath, 'utf8'), beforeText);
        results.push({ scenario: 'edit and save real modified file', passed: true });

        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.commands.executeCommand('vscode.openWith', modified, 'cweijan.markdownViewer');
        await vscode.commands.executeCommand('office.markdown.switch', modified);
        await until(() => tab()?.input instanceof vscode.TabInputText, 'single custom to text');
        await vscode.commands.executeCommand('office.markdown.switch', modified);
        await until(() => tab()?.input instanceof vscode.TabInputCustom, 'single text to custom');
        results.push({ scenario: 'single-file switching both directions', passed: true });

        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.commands.executeCommand('vscode.diff', original, modified, undefined,
            { preview: false, override: true, viewColumn: vscode.ViewColumn.Two });
        const comparisonGroup = vscode.window.tabGroups.activeTabGroup;
        await Promise.all([
            vscode.commands.executeCommand('office.markdown.switch', modified),
            vscode.commands.executeCommand('office.markdown.switch', modified),
        ]);
        assert.equal(vscode.window.tabGroups.activeTabGroup.viewColumn, comparisonGroup.viewColumn);
        assert.ok(snapshot().length <= 2, 'concurrent switches must not grow comparison tabs');
        if (!(tab()?.input instanceof vscode.TabInputTextDiff)) {
            await vscode.commands.executeCommand('office.markdown.switch', modified);
        }
        await until(() => tab()?.input instanceof vscode.TabInputTextDiff, 'second group returns to text');
        assert.equal(tab().input.original.toString(), original.toString());
        assert.equal(tab().input.modified.toString(), modified.toString());
        assert.equal(snapshot().length, 1, 'clean concurrent switches leave one comparison');
        results.push({ scenario: 'concurrent switching in a second editor group', passed: true });
    } catch (error) {
        results.push({ error: error.stack, actual: error.actual, expected: error.expected, tabs: snapshot(), documents: vscode.workspace.textDocuments.map(d => d.uri.toString()) });
        throw error;
    } finally {
        fs.writeFileSync(report, JSON.stringify({ vscode: vscode.version, results }, null, 2));
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        fs.rmSync(dir, { recursive: true, force: true });
    }
};
