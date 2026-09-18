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

/**
 * Diagram export payloads posted by the diagram popup's download button.
 * - `svg` carries serialized markup that is written to a user-chosen file
 * - `url` makes the host fetch and save a remote resource, so only the
 *   PlantUML renderer origins the webview itself renders from are allowed
 *   (arbitrary URLs would turn the host into a fetch proxy)
 */
export type SanitizedDiagramExport =
    | { mode: 'svg'; svg: string; fileName: string }
    | { mode: 'url'; url: string; fileName: string };

const DIAGRAM_SVG_MAX_LENGTH = 8 * 1024 * 1024;
const DIAGRAM_URL_MAX_LENGTH = 2048;
const DIAGRAM_FILE_NAME_MAX_LENGTH = 100;
const DIAGRAM_FILE_NAME_FALLBACK = 'diagram.svg';
const DIAGRAM_URL_ALLOWED_HOSTS = new Set(['plantuml.com', 'www.plantuml.com']);

/**
 * Strips anything that could smuggle path structure or markup-hostile
 * characters out of a webview-supplied file name, and forces the `.svg`
 * extension the save dialog offers.
 */
function sanitizeDiagramFileName(fileName: unknown): string {
    if (typeof fileName !== 'string') {
        return DIAGRAM_FILE_NAME_FALLBACK;
    }
    const base = fileName.split(/[\\/]/).pop() ?? '';
    const cleaned = base.replace(/[^\w.\- ()[\]]/g, '').replace(/[.\s]+$/, '');
    const trimmed = cleaned.slice(0, DIAGRAM_FILE_NAME_MAX_LENGTH);
    if (!trimmed || trimmed.startsWith('.')) {
        return DIAGRAM_FILE_NAME_FALLBACK;
    }
    return trimmed.toLowerCase().endsWith('.svg') ? trimmed : `${trimmed}.svg`;
}

const isDiagramSvgPayload = (svg: unknown): svg is string =>
    typeof svg === 'string'
    && svg.length > 0
    && svg.length <= DIAGRAM_SVG_MAX_LENGTH
    && svg.trimStart().startsWith('<');

const isDiagramUrlPayload = (url: unknown): url is string => {
    if (typeof url !== 'string' || url.length === 0 || url.length > DIAGRAM_URL_MAX_LENGTH) {
        return false;
    }
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        && DIAGRAM_URL_ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
};

/**
 * Validates a `saveDiagram` message body from the markdown webview and
 * returns the normalized export descriptor, or undefined when the payload
 * is not a single well-formed svg-or-url export. Exactly one of `svg` /
 * `url` must be present.
 */
export function sanitizeDiagramExportPayload(raw: unknown): SanitizedDiagramExport | undefined {
    if (typeof raw !== 'object' || raw === null) {
        return undefined;
    }
    const { svg, url, fileName } = raw as { svg?: unknown; url?: unknown; fileName?: unknown };
    const hasSvg = svg !== undefined;
    const hasUrl = url !== undefined;
    if (hasSvg === hasUrl) {
        return undefined;
    }
    if (hasSvg) {
        if (!isDiagramSvgPayload(svg)) {
            return undefined;
        }
        return { mode: 'svg', svg, fileName: sanitizeDiagramFileName(fileName) };
    }
    if (!isDiagramUrlPayload(url)) {
        return undefined;
    }
    return { mode: 'url', url, fileName: sanitizeDiagramFileName(fileName) };
}
