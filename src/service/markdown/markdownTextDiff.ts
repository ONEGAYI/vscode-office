import * as vscode from 'vscode';
import { buildTextDiffQuery, parseTextDiffSourceQuery, TEXT_DIFF_SCHEME } from './textDiffQuery';

export { TEXT_DIFF_SCHEME };

export class MarkdownTextDiffProvider implements vscode.TextDocumentContentProvider {
	provideTextDocumentContent(uri: vscode.Uri, _token: vscode.CancellationToken): Thenable<string> {
		const source = parseTextDiffSourceQuery(uri.query);
		if (!source) {
			return Promise.resolve('');
		}
		return vscode.workspace.fs.readFile(vscode.Uri.parse(source, true)).then(data => data.toString());
	}
}

/**
 * Reopens the given pair as a plain text diff (read-only snapshot).
 *
 * Diff sides are resolved per resource through the regular editor resolver,
 * so `vscode.diff` on two `file:` markdown uris would match the markdown
 * viewer selector again and open two webviews — exactly the layout the
 * switch command tries to escape. Wrapping each side under
 * `TEXT_DIFF_SCHEME` matches no custom editor selector, forcing plain text
 * editors on both sides.
 */
export function openTextDiff(original: vscode.Uri, modified: vscode.Uri, label: string): Thenable<unknown> {
	const nonce = Date.now();
	const wrap = (source: vscode.Uri) => vscode.Uri.from({
		scheme: TEXT_DIFF_SCHEME,
		path: `/${source.path.split('/').pop() ?? 'file'}`,
		query: buildTextDiffQuery(source.toString(true), nonce),
	});
	return vscode.commands.executeCommand('vscode.diff', wrap(original), wrap(modified), label, { preview: false });
}
