import * as vscode from 'vscode';

/**
 * Keep the real resources (and their dirty buffers/save lifecycle) in a
 * native text diff. VS Code's TextEditorOpenOptions converter accepts the
 * boolean `override` and translates it to the built-in text editor id.
 * This compatibility option is not exposed in the public options type;
 * the extension-host regression test covers it on VS Code 1.86.2.
 * Passing the string 'default' here does NOT survive that converter.
 */
export function openTextDiff(original: vscode.Uri, modified: vscode.Uri, label: string): Thenable<unknown> {
	return vscode.commands.executeCommand('vscode.diff', original, modified, label, { preview: false, override: true });
}

/** Re-resolve both real resources through their regular Markdown editor association. */
export function openMarkdownDiff(original: vscode.Uri, modified: vscode.Uri, label: string): Thenable<unknown> {
	return vscode.commands.executeCommand('vscode.diff', original, modified, label, { preview: false });
}

/** Explorer passes the focused resource separately from the ordered selection. */
export async function compareSelectedMarkdown(_resource?: vscode.Uri, resources?: vscode.Uri[]) {
	if (!Array.isArray(resources) || resources.length !== 2
		|| resources.some(uri => !vscode.Uri.isUri(uri) || !/\.(md|markdown)$/i.test(uri.path))
		|| resources[0].toString() === resources[1].toString()) {
		await vscode.window.showWarningMessage('Select two different Markdown files in Explorer to compare as text.');
		return;
	}
	const [original, modified] = resources;
	try {
		const stats = await Promise.all(resources.map(uri => vscode.workspace.fs.stat(uri)));
		if (stats.some(stat => !(stat.type & vscode.FileType.File))) {
			await vscode.window.showWarningMessage('Select two Markdown files, not folders, to compare as text.');
			return;
		}
		const name = (uri: vscode.Uri) => uri.path.split('/').pop()!;
		await openTextDiff(original, modified, `${name(original)} ↔ ${name(modified)}`);
	} catch (error) {
		await vscode.window.showErrorMessage(`Cannot open Markdown comparison: ${error instanceof Error ? error.message : String(error)}`);
	}
}
