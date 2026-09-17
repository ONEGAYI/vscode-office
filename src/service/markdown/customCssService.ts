import { homedir } from 'os';
import * as vscode from 'vscode';
import { broadcastToMarkdownWebviews } from '@/service/markdown/blockScroll';
import {
    SnippetSource,
    collectSnippetCssText,
    readmeMarkdownContent,
    resolveSnippetDirPath,
} from './customCssSnippets';

/** Editor-save flows fire bursts of watcher events; coalesce before re-reading. */
const WATCH_DEBOUNCE_MS = 300;

/**
 * Custom-CSS overlay: concatenates every `~/.vscode-office-css/*.css`
 * (filename order) into one stylesheet handed to the markdown webview as
 * a layer on top of the built-in ones. The webview maintains a single
 * `<style id="office-custom-css">`; host broadcasts `customCss`
 * `{ cssText }` on snippet-directory changes so open editors restyle
 * live. Web mode (no home directory) silently disables the feature.
 */
export class CustomCssService {

    private static watcher: vscode.FileSystemWatcher | undefined;
    private static debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private static cachedSnippetCount = 0;

    /** Snippets loaded by the last loadForWebview (0 = feature off/empty). */
    static get snippetCount(): number {
        return this.cachedSnippetCount;
    }

    static getSnippetDirUri(): vscode.Uri | undefined {
        if (vscode.env.uiKind === vscode.UIKind.Web) {
            return undefined;
        }
        const dir = resolveSnippetDirPath(homedir() || undefined);
        return dir ? vscode.Uri.file(dir) : undefined;
    }

    /** Creates the snippet dir with a comments-only README on first use. */
    private static async ensureSnippetDir(dirUri: vscode.Uri): Promise<void> {
        // createDirectory is idempotent so racing panels that both see a
        // missing dir still converge, and both write the same README
        await vscode.workspace.fs.createDirectory(dirUri);

        // legacy scaffold: an old README.css that is still pure comments
        // was never repurposed by the user - safe to clean up
        const legacyUri = vscode.Uri.joinPath(dirUri, 'README.css');
        try {
            const legacyBytes = await vscode.workspace.fs.readFile(legacyUri);
            const legacyText = Buffer.from(legacyBytes).toString('utf8');
            if (legacyText.replace(/\/\*[\s\S]*?\*\//g, '').trim() === '') {
                await vscode.workspace.fs.delete(legacyUri);
            }
        } catch {
            // not present - nothing to clean
        }

        // README.md is extension-owned documentation (its header says so):
        // detect-then-write keeps the on-disk copy identical to the
        // installed extension while avoiding needless writes. Being .md,
        // it is invisible to the *.css scanner and watcher.
        const readmeUri = vscode.Uri.joinPath(dirUri, 'README.md');
        const nextReadme = readmeMarkdownContent();
        try {
            const bytes = await vscode.workspace.fs.readFile(readmeUri);
            if (Buffer.from(bytes).toString('utf8') === nextReadme) {
                return;
            }
        } catch {
            // not present yet - write below
        }
        await vscode.workspace.fs.writeFile(readmeUri, Buffer.from(nextReadme, 'utf8'));
    }

    /**
     * Reads the whole directory (filename order, per-file failures skipped)
     * and registers the watcher once. Returns the overlay stylesheet text;
     * '' when the feature is disabled or the directory is empty.
     */
    static async loadForWebview(): Promise<string> {
        const result = await this.readSnippetDir();
        return result ? result.cssText : '';
    }

    /** undefined = directory-level failure: keep the last broadcast styles. */
    private static async readSnippetDir(): Promise<{ cssText: string } | undefined> {
        const dirUri = this.getSnippetDirUri();
        if (!dirUri) {
            this.cachedSnippetCount = 0;
            return { cssText: '' };
        }
        try {
            await this.ensureSnippetDir(dirUri);
            this.ensureWatcher(dirUri);
            const sources: SnippetSource[] = [];
            for (const [name, type] of await vscode.workspace.fs.readDirectory(dirUri)) {
                // bitmask: a symlinked css still reports File|SymbolicLink
                if ((type & vscode.FileType.File) === 0 || !name.toLowerCase().endsWith('.css')) {
                    continue;
                }
                sources.push({
                    name,
                    read: async () => {
                        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dirUri, name));
                        return Buffer.from(bytes).toString('utf8');
                    },
                });
            }
            // scaffold assets are .md (invisible here) or cleaned up in
            // ensureSnippetDir, so every .css left is a user snippet
            this.cachedSnippetCount = sources.length;
            const cssText = await collectSnippetCssText(sources, (name, error) => {
                console.warn(`[vscode-office] custom css snippet skipped: ${name}`, error);
            });
            return { cssText };
        } catch (error) {
            // a transient/unreadable snippet dir must never break opening a
            // doc; on the watcher path the failure is visible in the log and
            // the previous overlay stays applied
            console.warn('[vscode-office] custom css directory unavailable', error);
            return undefined;
        }
    }

    /**
     * Entry point shared by the Settings-panel button and the command
     * palette: reveals the snippet folder in the OS file manager,
     * creating it on first use.
     */
    static async openSnippetFolder(): Promise<void> {
        const dirUri = this.getSnippetDirUri();
        if (!dirUri) {
            vscode.window.showWarningMessage('Custom CSS snippets are not supported in this environment.');
            return;
        }
        try {
            await this.ensureSnippetDir(dirUri);
            vscode.commands.executeCommand('revealFileInOS', dirUri);
        } catch {
            // opening a folder must never surface errors into the editor
        }
    }

    private static ensureWatcher(dirUri: vscode.Uri): void {
        if (this.watcher) {
            return;
        }
        const pattern = new vscode.RelativePattern(dirUri, '**/*.css');
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        const onSnippetChange = () => this.scheduleReload();
        watcher.onDidChange(onSnippetChange);
        watcher.onDidCreate(onSnippetChange);
        watcher.onDidDelete(onSnippetChange);
        this.watcher = watcher;
    }

    private static scheduleReload(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = undefined;
            void this.readSnippetDir().then(result => {
                // a failed reload keeps the last applied overlay instead of
                // blanking every open editor
                if (result !== undefined) {
                    broadcastToMarkdownWebviews('customCss', { cssText: result.cssText });
                }
            });
        }, WATCH_DEBOUNCE_MS);
    }

    static dispose(): void {
        this.watcher?.dispose();
        this.watcher = undefined;
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }
    }

}
