/**
 * Pure helpers for the `TEXT_DIFF_SCHEME` uris that force the built-in text
 * diff editor. Kept free of the `vscode` module so it can be unit-tested
 * directly under `node --test`.
 */

/**
 * Internal scheme: content-provider-backed markdown that matches no custom
 * editor selector, so diff sides served under it always resolve to plain
 * text editors.
 */
export const TEXT_DIFF_SCHEME = 'office-md-textdiff';

/**
 * Builds the query carried by a `TEXT_DIFF_SCHEME` uri. `nonce` keeps the
 * uri unique per call so VSCode never reuses a stale cached text model from
 * an earlier diff of the same files.
 */
export function buildTextDiffQuery(sourceUri: string, nonce: number): string {
	return `src=${encodeURIComponent(sourceUri)}&t=${nonce}`;
}

/**
 * Extracts the wrapped source uri from a `TEXT_DIFF_SCHEME` uri query.
 * `URLSearchParams` already percent-decodes the value once, so no extra
 * decode here. Returns undefined when the query is malformed.
 */
export function parseTextDiffSourceQuery(query: string): string | undefined {
	const src = new URLSearchParams(query).get('src');
	if (!src) {
		return undefined;
	}
	return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src) ? src : undefined;
}
