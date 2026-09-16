/**
 * Validation for values crossing the webview → extension-host boundary.
 *
 * The markdown webview renders untrusted document content, so anything it
 * posts to the host must be treated as attacker-controlled. These pure
 * helpers are the choke point used by MarkdownEditorProvider to harden its
 * message handlers:
 *
 * - image extensions are interpolated into file-system paths
 *   (path traversal via crafted `ext` payloads)
 * - external links are handed to `vscode.env.openExternal`, which passes
 *   them to the OS handler (pivots via `vscode:`, `file:`, custom schemes)
 * - the `command` message forwards straight into `executeCommand`
 *   (defense in depth: the only sender today is the context menu)
 */

const IMAGE_EXTENSION_PATTERN = /^[a-z0-9]{1,10}$/;

/**
 * Sanitizes a webview-supplied image extension before it is interpolated
 * into a file-system path. Returns the normalized extension, or undefined
 * when the value is not a plain alphanumeric extension; callers fall back
 * to `png`, matching the previous default for missing values.
 */
export function sanitizeImageExtension(ext: unknown): string | undefined {
    if (typeof ext !== 'string') {
        return undefined;
    }
    const normalized = ext.trim().toLowerCase();
    if (!IMAGE_EXTENSION_PATTERN.test(normalized)) {
        return undefined;
    }
    return normalized;
}

const OPEN_EXTERNAL_ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto']);
const URI_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Extracts the leading URI scheme, or undefined for scheme-less and
 * malformed values. The check runs on the trimmed string; callers that
 * consume the link afterwards (e.g. `vscode.Uri.parse`) must use the same
 * trimmed value so validation and parsing cannot disagree.
 */
export function extractUriScheme(linkUri: unknown): string | undefined {
    if (typeof linkUri !== 'string' || linkUri.length === 0) {
        return undefined;
    }
    const match = URI_SCHEME_PATTERN.exec(linkUri.trim());
    return match ? match[1].toLowerCase() : undefined;
}

/**
 * Whether a link posted by the webview may be handed to the OS handler via
 * `openExternal`. Only user-browsable schemes are allowed; everything else
 * (`file:`, `vscode:`, `command:`, custom protocols, scheme-less or
 * malformed values) must be dropped by the caller.
 */
export function isOpenExternalLinkAllowed(linkUri: unknown): boolean {
    const scheme = extractUriScheme(linkUri);
    return scheme !== undefined && OPEN_EXTERNAL_ALLOWED_SCHEMES.has(scheme);
}

/**
 * Commands the markdown webview is allowed to ask the host to execute.
 * `office.markdown.paste` is the only sender today (context menu,
 * resource/markdown/util.js); keeping this an explicit allowlist prevents
 * the channel from becoming an arbitrary-execution primitive.
 */
const WEBVIEW_ALLOWED_COMMANDS: ReadonlySet<string> = new Set(['office.markdown.paste']);

export function isWebviewCommandAllowed(command: unknown): boolean {
    return typeof command === 'string' && WEBVIEW_ALLOWED_COMMANDS.has(command);
}
