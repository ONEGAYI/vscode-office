import * as vscode from 'vscode';
import { SimpleEventEmitter } from "./simpleEventEmitter";
import { WebviewPanel } from "vscode";
import { Output } from "./Output";
import { fileSystemPathsEqual } from "./fileSystemPathsEqual";

export class Handler {

    private isEnd: boolean;
    constructor(public panel: WebviewPanel, private eventEmitter: SimpleEventEmitter) { }

    on(event: string, callback: (content: any) => any | Promise<any>): this {
        if (event != 'init') {
            const listens = this.eventEmitter.listeners(event)
            if (listens.length >= 1) {
                this.eventEmitter.removeListener(event, listens[0])
            }
        }
        this.eventEmitter.on(event, async (content: any) => {
            try {
                await callback(content)
            } catch (error) {
                Output.debug(error)
                vscode.window.showErrorMessage(error.message)
            }
        })
        return this;
    }

    emit(event: string, content?: any) {
        if (this.isEnd) return this;
        this.panel.webview.postMessage({ type: event, content })
        return this;
    }

    public static bind(panel: WebviewPanel, uri: vscode.Uri): Handler {
        const eventEmitter = new SimpleEventEmitter();

        const fileWatcher = Handler.createFileWatcher(uri);
        const isWatchedFile = (eventUri: vscode.Uri | undefined) =>
            !!eventUri && fileSystemPathsEqual(eventUri.fsPath, uri.fsPath, Handler.pathCaseInsensitive());
        fileWatcher?.onDidChange(e => {
            if (isWatchedFile(e)) {
                eventEmitter.emit("fileChange", e)
            }
        })
        fileWatcher?.onDidDelete(e => {
            if (isWatchedFile(e)) {
                eventEmitter.emit("fileChange", e)
            }
        })

        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === uri.toString() && e.contentChanges.length > 0) {
                eventEmitter.emit("externalUpdate", e)
            }
        });
        const handle = new Handler(panel, eventEmitter)
        panel.onDidDispose(() => {
            handle.isEnd = true;
            fileWatcher?.dispose()
            changeDocumentSubscription.dispose()
            eventEmitter.emit("dispose")
        });

        // bind from webview
        panel.webview.onDidReceiveMessage((message) => {
            eventEmitter.emit(message.type, message.content)
        })
        return handle;
    }

    /**
     * Evaluated lazily: the web extension host (vscode.dev) has no
     * `process` global, and a class field initializer runs at module
     * load time, which would break the entire web build's activation.
     * There the comparison stays case-sensitive — a missed refresh at
     * worst, since web-host file events depend on the browser fs
     * provider anyway.
     */
    private static pathCaseInsensitive(): boolean {
        return typeof process !== 'undefined'
            && (process.platform === 'win32' || process.platform === 'darwin');
    }

    /**
     * Watches exactly this file. Virtual schemes (untitled:, ...) have no
     * disk to diverge from and stay unwatched.
     *
     * The pattern must not contain the file name: VS Code's glob matcher
     * has no escape syntax (a "\" is an escaped regexp backslash — "["
     * still opens a character class), so a name like "report[1].md"
     * would silently never match. Watching the literal parent folder (a
     * Uri base carries no glob meaning) with a single-level "*" and
     * filtering events by exact path keeps user-controlled path
     * characters out of the pattern entirely.
     */
    private static createFileWatcher(uri: vscode.Uri): vscode.FileSystemWatcher | undefined {
        if (uri.scheme !== 'file') {
            return undefined;
        }
        const parentFolder = vscode.Uri.joinPath(uri, '..');
        return vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(parentFolder, '*'));
    }

}
