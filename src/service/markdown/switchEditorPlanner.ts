/**
 * Pure decision logic for the markdown editor switch command
 * (`office.markdown.switch`). Kept free of the `vscode` module so it can be
 * unit-tested directly under `node --test`.
 */
export interface SwitchEditorContext {
	/** Uri passed by the editor/title menu, if any. */
	readonly commandUri?: string;
	/** Document uri of the active text editor, when a plain text editor has focus. */
	readonly activeTextEditorUri?: string;
	/** Original/modified uris of the active tab, when it shows a text diff. */
	readonly activeTabDiff?: {
		readonly original: string;
		readonly modified: string;
		readonly label: string;
	};
}

export type SwitchEditorPlan =
	| {
		readonly action: 'diff';
		readonly original: string;
		readonly modified: string;
		readonly label: string;
	}
	| {
		readonly action: 'openWith';
		readonly uri: string;
		readonly viewType: 'cweijan.markdownViewer' | 'default';
	};

/**
 * Decides how the switch command should reopen the current editor:
 *
 * - inside a diff editor: reopen the pair as a plain text diff, so switching
 *   never collapses the comparison into a single file;
 * - plain text editor focused: reopen the document in the markdown viewer;
 * - custom editor focused: reopen the document with the default text editor.
 */
export function planSwitchEditor(context: SwitchEditorContext): SwitchEditorPlan | undefined {
	const diff = context.activeTabDiff;
	if (diff) {
		return {
			action: 'diff',
			original: diff.original,
			modified: diff.modified,
			label: diff.label,
		};
	}
	if (context.activeTextEditorUri) {
		return {
			action: 'openWith',
			uri: context.commandUri ?? context.activeTextEditorUri,
			viewType: 'cweijan.markdownViewer',
		};
	}
	const uri = context.commandUri;
	if (!uri) {
		return undefined;
	}
	return { action: 'openWith', uri, viewType: 'default' };
}
