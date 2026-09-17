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
