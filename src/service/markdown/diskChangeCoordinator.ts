/**
 * Per-uri coordination for the external-disk-change backstop.
 *
 * One markdown file can be open in several editor panels at once. Every
 * panel owns its own Handler (watcher + fileChange listener), so without
 * cross-panel coordination a single external write would surface one
 * "Load disk version / Keep my edits" prompt per panel, and a decision
 * made in panel A would overwrite edits that panel B had not yet been
 * asked about.
 *
 * This module owns the state that must be shared per document uri:
 *
 * - the prompt slot: at most one panel may be asking at any time; the
 *   other panels follow the outcome through the shared text document
 *   and the update events it produces
 * - the acknowledged disk texts: "Keep my edits" in one panel must
 *   silence the same disk text in every panel
 * - the panel content snapshots: the decision core should treat the
 *   latest webview content of *any* panel as a form of the user's
 *   buffer, so a save from another panel is recognized as an echo
 *   instead of an external change
 * - the deleted-notification latch: the file-watcher reports a delete
 *   once, but the re-check tail after a decision would re-read the
 *   missing file and re-notify
 *
 * The module is vscode-free on purpose so it stays unit-testable.
 */

export interface DiskChangePanel {
    /** Latest normalized (CR-stripped) webview content of that panel. */
    getContent(): string;
}

interface UriDiskChangeState {
    panels: Set<DiskChangePanel>;
    acknowledgedDiskTexts: Set<string>;
    prompting: boolean;
    deletedNotified: boolean;
}

const statesByUri = new Map<string, UriDiskChangeState>();

function ensureState(uriKey: string): UriDiskChangeState {
    let state = statesByUri.get(uriKey);
    if (!state) {
        state = {
            panels: new Set(),
            acknowledgedDiskTexts: new Set(),
            prompting: false,
            deletedNotified: false,
        };
        statesByUri.set(uriKey, state);
    }
    return state;
}

function collectIfOrphaned(uriKey: string): void {
    const state = statesByUri.get(uriKey);
    if (state && state.panels.size === 0 && !state.prompting) {
        statesByUri.delete(uriKey);
    }
}

/** Registers a panel for this uri; returns its dispose function. */
export function registerDiskChangePanel(uriKey: string, panel: DiskChangePanel): () => void {
    const state = ensureState(uriKey);
    state.panels.add(panel);
    let disposed = false;
    return () => {
        if (disposed) {
            return;
        }
        disposed = true;
        state.panels.delete(panel);
        collectIfOrphaned(uriKey);
    };
}

/**
 * Claims the right to show the disk-change prompt for this uri. Returns
 * false when another panel is already asking — the caller must stand by
 * and follow that panel's decision instead of prompting again.
 */
export function tryBeginDiskChangePrompt(uriKey: string): boolean {
    const state = ensureState(uriKey);
    if (state.prompting) {
        return false;
    }
    state.prompting = true;
    return true;
}

/** Releases the prompt slot claimed by a successful begin. */
export function endDiskChangePrompt(uriKey: string): void {
    const state = statesByUri.get(uriKey);
    if (state) {
        state.prompting = false;
    }
    collectIfOrphaned(uriKey);
}

/**
 * The acknowledged-disk-text set is shared by every panel of this uri:
 * a "Keep my edits" decision must silence the same disk text in all of
 * them. Mutating the returned set updates the shared state.
 */
export function getSharedAcknowledgedDiskTexts(uriKey: string): Set<string> {
    return ensureState(uriKey).acknowledgedDiskTexts;
}

/**
 * Content snapshots of every live panel of this uri, in registration
 * order. Feed these into the decision core alongside the calling
 * panel's own buffer forms so echoes from sibling panels are detected.
 */
export function collectPanelBufferTexts(uriKey: string): string[] {
    const state = statesByUri.get(uriKey);
    if (!state) {
        return [];
    }
    const texts: string[] = [];
    for (const panel of state.panels) {
        texts.push(panel.getContent());
    }
    return texts;
}

/**
 * One-shot latch for "file was deleted externally" notifications:
 * fires true once, then stays false until the file exists again and
 * the caller clears the latch from a successful re-read.
 */
export function shouldNotifyDeletedOnce(uriKey: string): boolean {
    const state = ensureState(uriKey);
    if (state.deletedNotified) {
        return false;
    }
    state.deletedNotified = true;
    return true;
}

/** Clears the deleted latch after the file was read successfully again. */
export function clearDeletedNotified(uriKey: string): void {
    const state = statesByUri.get(uriKey);
    if (state) {
        state.deletedNotified = false;
    }
}

/** Test-only: detaches all panels and drops all uri state. */
export function resetDiskChangeCoordinatorForTest(): void {
    statesByUri.clear();
}
