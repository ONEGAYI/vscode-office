/**
 * Decision core for the external-disk-change backstop of the markdown
 * editor.
 *
 * VS Code never reloads a dirty text document when its file changes on
 * disk: no reload, no event. This editor's sync model (webview input →
 * applyEdit → the file is only written on save) keeps the document dirty
 * almost constantly, so external writers (formatters, agents, other
 * editors) silently vanish from an open editor view — and the next manual
 * save clobbers their changes with the stale buffer.
 *
 * The provider already owns a FileSystemWatcher (Handler) whose fileChange
 * events were previously unconsumed. These helpers decide when the user
 * should be asked about diverging disk content; the provider owns the UX:
 *
 * - "Load disk version": re-read the disk right before applying (never a
 *   stale snapshot), applyEdit + save, push the content to the webview.
 * - "Keep my edits": leave the buffer untouched and acknowledge this
 *   exact disk text so streaming writers do not re-prompt.
 */

const UTF8_BOM = '\uFEFF';
const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * Normalizes raw disk bytes the same way the editor's sync path normalizes
 * document text (UTF-8 BOM stripped, CR removed), so comparisons against
 * the tracked buffer content are meaningful.
 *
 * Returns undefined when the bytes are not valid UTF-8. VS Code may decode
 * documents with other encodings (files.encoding / autoGuessEncoding) into
 * the text model; comparing such a document against a UTF-8 interpretation
 * of the same file would diverge on every check, and adopting the mojibake
 * via "Load disk version" would persist double-encoded corruption. For
 * non-UTF-8 files the backstop simply stays out of the way (old behavior).
 */
export function normalizeDiskText(bytes: Uint8Array): string | undefined {
    let text: string;
    try {
        text = STRICT_UTF8_DECODER.decode(bytes);
    } catch {
        return undefined;
    }
    if (text.startsWith(UTF8_BOM)) {
        text = text.slice(1);
    }
    return text.replace(/\r/g, '');
}

export interface ExternalChangeDecision {
    /**
     * Current and recent forms of the user's buffer, normalized: the
     * latest webview content, the applied document text, and recently
     * flushed snapshots. While a save is flushing these can briefly
     * differ; the disk matching any form is an echo of our own write,
     * not an external change.
     */
    bufferTexts: ReadonlyArray<string>;
    diskText: string;
    isDirty: boolean;
    /** Disk texts the user already declined to load. */
    acknowledgedDiskTexts: ReadonlySet<string>;
}

/**
 * Whether the user should be asked about this disk content. Clean
 * documents never ask (VS Code auto-reloads them and the regular change
 * event reaches the webview); dirty documents ask once per distinct disk
 * text that differs from every form of the buffer.
 */
export function shouldAskAboutDiskChange(decision: ExternalChangeDecision): boolean {
    if (!decision.isDirty) {
        return false;
    }
    if (decision.bufferTexts.includes(decision.diskText)) {
        return false;
    }
    if (decision.acknowledgedDiskTexts.has(decision.diskText)) {
        return false;
    }
    return true;
}
