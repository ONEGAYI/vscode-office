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
		readonly viewType: 'cweijan.markdownViewer' | 'default';
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
 * - inside a text diff: reopen the pair in the markdown editors, so switching
 *   never collapses the comparison into a single file;
 * - plain text editor focused: reopen the document in the markdown viewer;
 * - custom editor focused: reopen the document with the default text editor.
 */
export function planSwitchEditor(context: SwitchEditorContext): SwitchEditorPlan | undefined {
	const diff = context.activeTabDiff;
	if (diff) {
		return {
			action: 'diff',
			viewType: 'cweijan.markdownViewer',
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

/** Minimal info about an open tab, normalized from the vscode Tab API. */
export interface OpenTabInfo {
	readonly label: string;
	/** Resource uri of a single-file tab (text or custom editor), if any. */
	readonly uri?: string;
}

/** Splits a diff tab label like `b.md ↔ a.md` into its two sides. */
export function parseDiffLabel(label: string): { left: string; right: string } | undefined {
	const idx = label.indexOf(' ↔ ');
	if (idx < 0) {
		return undefined;
	}
	const left = label.slice(0, idx).trim();
	const right = label.slice(idx + ' ↔ '.length).trim();
	if (!left || !right) {
		return undefined;
	}
	return { left, right };
}

function baseName(uri: string): string {
	try {
		return decodeURIComponent(new URL(uri).pathname.split('/').pop() ?? '');
	} catch {
		return '';
	}
}

/**
 * Resolves both sides of a diff tab whose input exposes no uris to the
 * extension API (VSCode reports diff tabs with custom editors on either
 * side as opaque/unknown, with no original/modified pair).
 *
 * The tab label carries the two file names (`b.md ↔ a.md`); the command uri
 * identifies one side when supplied. Open documents include the diff's
 * sources even when their standalone tabs have closed. Ambiguous names
 * must not guess a different file, even if it shares the command's folder.
 */
export function resolveUnknownDiffSides(
	diffLabel: string,
	commandUri: string | undefined,
	tabs: readonly OpenTabInfo[],
): { original: string; modified: string } | undefined {
	const parsed = parseDiffLabel(diffLabel);
	if (!parsed || parsed.left === parsed.right) {
		return undefined;
	}
	if (!commandUri) {
		const candidates = (name: string) => [...new Set(tabs
			.filter(tab => tab.uri && baseName(tab.uri) === name)
			.map(tab => tab.uri!))];
		const originals = candidates(parsed.left);
		const modifieds = candidates(parsed.right);
		return originals.length === 1 && modifieds.length === 1 && originals[0] !== modifieds[0]
			? { original: originals[0], modified: modifieds[0] } : undefined;
	}
	const cmdName = baseName(commandUri);
	let otherName: string;
	let otherIsOriginal: boolean;
	if (cmdName === parsed.right) {
		otherName = parsed.left;
		otherIsOriginal = true;
	} else if (cmdName === parsed.left) {
		otherName = parsed.right;
		otherIsOriginal = false;
	} else {
		return undefined;
	}
	const candidates = [...new Set(tabs
		.filter(tab => tab.uri && tab.uri !== commandUri && baseName(tab.uri) === otherName)
		.map(tab => tab.uri!))];
	if (candidates.length !== 1) {
		return undefined;
	}
	const best = candidates[0];
	return otherIsOriginal
		? { original: best, modified: commandUri }
		: { original: commandUri, modified: best };
}
