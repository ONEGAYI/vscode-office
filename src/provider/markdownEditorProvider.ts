import { adjustImgPath, getWorkspacePath } from '@/common/fileUtil';
import { isAbsolute, parse, resolve } from 'path';
import * as vscode from 'vscode';
import { extensionResource, getExtensionResourceRoots, readExtensionText } from '@/common/extensionResource';
import { ensureParentDirectory } from '@/common/workspaceFs';
import { Handler } from '../common/handler';
import { Util } from '../common/util';
import { Holder } from '../service/markdown/holder';
import { MarkdownService } from '../service/markdownService';
import {
    normalizeDiskText,
    shouldAskAboutDiskChange,
} from '../service/markdown/externalChangeGuard';
import {
    clearDeletedNotified,
    collectPanelBufferTexts,
    endDiskChangePrompt,
    getSharedAcknowledgedDiskTexts,
    registerDiskChangePanel,
    shouldNotifyDeletedOnce,
    tryBeginDiskChangePrompt,
} from '../service/markdown/diskChangeCoordinator';
import { Global, i18n } from '@/common/global';
import { TelemetryService } from '@/service/telemetryService';
import { openWikiLink } from '@/service/markdown/wikilink';
import { streamCustomAI } from '@/service/ai/customAIClient';
import { buildAIOutputLanguageInstruction } from '@/service/ai/aiOutputLanguage';
import {
    broadcastToMarkdownWebviews,
    consumePendingBlockScroll,
    registerMarkdownWebview,
    unregisterMarkdownWebview,
} from '@/service/markdown/blockScroll';
import { ViewerSettingsService } from '@/service/viewerSettingsService';
import { fileTypeFromPath } from '@/service/officeViewType';
import { parseWebviewResourceUri } from '@/common/webviewUri';

function getRuntimePlatform(): string {
    if (typeof process !== 'undefined' && process.platform) {
        return process.platform;
    }
    return 'web';
}

export interface MarkdownEditorProviderOptions {
    isWeb?: boolean;
}

const MARKDOWN_SYNC_CONFIG_KEYS = [
    'editMode',
    'editorTheme',
    'codeMirrorTheme',
    'mermaidTheme',
] as const;

type MarkdownSyncConfigKey = typeof MARKDOWN_SYNC_CONFIG_KEYS[number];

/**
 * support view and edit office files.
 */
export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {

    private static legacyGlobalStatePurged = false;

    /**
     * Pending "Load disk version / Keep my edits" decisions per document
     * uri. Saves of a document with a pending decision are parked via
     * onWillSaveTextDocument until the user answers, so autosave or a
     * reflexive Ctrl+S cannot silently overwrite the external change the
     * prompt is asking about.
     */
    private static pendingDiskDecisions = new Map<string, Promise<void>>();
    private static diskDecisionGuardRegistered = false;

    private countStatus: vscode.StatusBarItem;
    private aiAbortController: AbortController | null = null;
    private aiCancellationSource: vscode.CancellationTokenSource | null = null;

    private getMarkdownTelemetryProps(configuration = vscode.workspace.getConfiguration("vscode-office")) {
        return {
            editorTheme: String(configuration.get<string>("editorTheme", "Auto")),
            codeTheme: String(configuration.get<string>("codeMirrorTheme", "Auto")),
        };
    }

    constructor(
        private context: vscode.ExtensionContext, private options: MarkdownEditorProviderOptions = {}
    ) {
        this.countStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.purgeLegacyGlobalState();
        MarkdownEditorProvider.registerConfigSync(this.context);
        MarkdownEditorProvider.registerDiskDecisionGuard(this.context);
    }

    static registerConfigSync(context: vscode.ExtensionContext): void {
        if (MarkdownEditorProvider.configSyncRegistered) {
            return;
        }
        MarkdownEditorProvider.configSyncRegistered = true;
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration((event) => {
                const config = vscode.workspace.getConfiguration('vscode-office');
                const patch: Partial<Record<MarkdownSyncConfigKey, unknown>> = {};
                let changed = false;
                for (const key of MARKDOWN_SYNC_CONFIG_KEYS) {
                    if (event.affectsConfiguration(`vscode-office.${key}`)) {
                        patch[key] = config.get(key);
                        changed = true;
                    }
                }
                if (changed) {
                    broadcastToMarkdownWebviews('markdownConfig', patch);
                }
            }),
        );
    }

    private static configSyncRegistered = false;

    static registerDiskDecisionGuard(context: vscode.ExtensionContext): void {
        if (MarkdownEditorProvider.diskDecisionGuardRegistered) {
            return;
        }
        MarkdownEditorProvider.diskDecisionGuardRegistered = true;
        context.subscriptions.push(
            vscode.workspace.onWillSaveTextDocument(event => {
                const pending = MarkdownEditorProvider.pendingDiskDecisions.get(event.document.uri.toString());
                if (pending) {
                    event.waitUntil(pending);
                }
            }),
        );
    }

    private purgeLegacyGlobalState() {
        if (MarkdownEditorProvider.legacyGlobalStatePurged) {
            return;
        }
        MarkdownEditorProvider.legacyGlobalStatePurged = true;
        const state = this.context.globalState;
        for (const key of state.keys()) {
            if (key.startsWith('scrollTop_')) {
                void state.update(key, undefined);
            }
        }
    }

    private getFolders(): vscode.Uri[] {
        if (vscode.env.uiKind === vscode.UIKind.Web) {
            return [];
        }
        const data = [];
        for (let i = 65; i <= 90; i++) {
            data.push(vscode.Uri.file(`${String.fromCharCode(i)}:/`))
        }
        return data;
    }

    private getWorkspaceUriByFileUtil(uri: vscode.Uri): vscode.Uri | undefined {
        const workspacePath = getWorkspacePath(uri);
        if (!workspacePath) {
            return undefined;
        }
        return vscode.Uri.file(workspacePath);
    }

    resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel, token: vscode.CancellationToken): void | Thenable<void> {
        // console.log('schema', document.uri.scheme, document.uri.path, document.uri.query);
        const uri = document.uri;
        const webview = webviewPanel.webview;
        const folderPath = vscode.Uri.joinPath(uri, '..')
        webview.options = {
            enableScripts: true,
            localResourceRoots: [
                ...getExtensionResourceRoots(this.context),
                folderPath,
                ...(vscode.workspace.workspaceFolders?.map(folder => folder.uri) ?? []),
                vscode.Uri.file("/"),
                ...this.getFolders(),
            ],
        }
        const handler = Handler.bind(webviewPanel, uri);
        TelemetryService.get()?.trackViewOpen(
            'markdown',
            fileTypeFromPath(uri.fsPath),
            this.getMarkdownTelemetryProps(),
        );
        void this.handleMarkdown(document, handler, folderPath);
        handler.on('developerTool', () => vscode.commands.executeCommand('workbench.action.toggleDevTools'))
    }

    private async handleMarkdown(document: vscode.TextDocument, handler: Handler, folderPath: vscode.Uri) {

        const uri = document.uri;
        const webview = handler.panel.webview;

        let content = document.getText();
        const contextUri = extensionResource(this.context, 'resource', 'markdown');
        const rootPath = webview.asWebviewUri(contextUri).toString();

        Holder.activeDocument = document;
        handler.panel.onDidChangeViewState(e => {
            Holder.activeDocument = e.webviewPanel.visible ? document : Holder.activeDocument
            if (e.webviewPanel.visible) {
                this.updateCount(content)
                this.countStatus.show()
            } else {
                this.countStatus.hide()
            }
        });

        let lastManualSaveTime: number;
        let documentSyncTimer: ReturnType<typeof setTimeout> | undefined;
        let pendingDocumentSync: string | undefined;
        const flushDocumentSync = async () => {
            if (documentSyncTimer) {
                clearTimeout(documentSyncTimer);
                documentSyncTimer = undefined;
            }
            if (pendingDocumentSync === undefined) {
                return;
            }
            const nextContent = pendingDocumentSync;
            pendingDocumentSync = undefined;
            rememberBufferText(document.getText().replace(/\r/g, ''));
            content = nextContent;
            await this.updateTextDocument(document, nextContent);
        };
        const scheduleDocumentSync = (newContent: string) => {
            pendingDocumentSync = newContent;
            content = newContent;
            this.updateCount(content);
            if (documentSyncTimer) {
                clearTimeout(documentSyncTimer);
            }
            // Debounce to avoid triggering VS Code built-in mermaid-markdown-features
            // re-parsing on every keystroke (ANTLR token recognition errors in console).
            documentSyncTimer = setTimeout(() => void flushDocumentSync(), 400);
        };
        const config = vscode.workspace.getConfiguration("vscode-office");
        registerMarkdownWebview(uri, handler);
        handler.panel.onDidDispose(() => {
            panelDisposed = true;
            void flushDocumentSync();
            unregisterMarkdownWebview(uri);
            // keep this panel's content out of cross-panel echo checks
            // after its last flush has landed
            unregisterDiskPanel();
        });

        // VS Code never reloads a dirty document when its file changes on
        // disk (no event fires), and this editor keeps the document dirty
        // between input and save — so external writers would silently
        // vanish and the next save clobber them. The Handler's fileChange
        // watcher is the backstop: ask before anything is overwritten.
        //
        // "Load disk version" adopts the disk content and discards unsaved
        // local edits — the same contract as VS Code's own conflict flow.
        // Two accepted millisecond-scale windows remain (the extension API
        // has no atomic read-modify-write): between the re-read and
        // document.save(), and between releasing a save parked by the
        // decision guard and the re-read itself.
        // Cross-panel coordination (the same file can be open in several
        // editor panels): the prompt slot and the acknowledged-disk-text
        // set are per-uri global state, so "Keep my edits" in one panel
        // silences the same disk text everywhere and only one panel ever
        // prompts. Sibling panels' latest content also joins the buffer
        // forms below: a flush from another panel is an echo, not an
        // external change.
        const uriKey = uri.toString();
        const unregisterDiskPanel = registerDiskChangePanel(uriKey, { getContent: () => content });
        // Guards the re-check tail below: once this panel is gone its
        // closure state (content, the shared-set reference) is orphaned,
        // and re-prompting from it could not be acknowledged properly.
        let panelDisposed = false;
        const acknowledgedDiskTexts = getSharedAcknowledgedDiskTexts(uriKey);
        // Recent pre-flush document snapshots: a save triggered while focus
        // is outside the webview writes the applied document text, which a
        // still-pending flush then advances past — the disk matching such a
        // snapshot is an echo of our own save, not an external change.
        const recentBufferTexts: string[] = [];
        const rememberBufferText = (text: string) => {
            const index = recentBufferTexts.indexOf(text);
            if (index >= 0) {
                recentBufferTexts.splice(index, 1);
            }
            recentBufferTexts.push(text);
            if (recentBufferTexts.length > 8) {
                recentBufferTexts.shift();
            }
        };
        const loadDiskVersion = async (): Promise<void> => {
            let diskBytes: Uint8Array;
            try {
                diskBytes = await vscode.workspace.fs.readFile(uri);
            } catch {
                return;
            }
            const latestText = normalizeDiskText(diskBytes);
            if (latestText === undefined || latestText === content) {
                return;
            }
            acknowledgedDiskTexts.clear();
            if (documentSyncTimer) {
                clearTimeout(documentSyncTimer);
                documentSyncTimer = undefined;
            }
            pendingDocumentSync = undefined;
            content = latestText;
            this.updateCount(content);
            try {
                await this.updateTextDocument(document, latestText);
                const saved = await document.save();
                if (saved === false) {
                    vscode.window.showWarningMessage(
                        i18n('ext.markdown.externalSaveFailed', parse(uri.fsPath).base));
                }
                handler.emit("update", latestText);
            } catch {
                // the panel may have closed mid-flight; disk stays authoritative
            }
        };
        const checkExternalDiskChange = async (): Promise<void> => {
            if (panelDisposed) {
                return;
            }
            if (!tryBeginDiskChangePrompt(uriKey)) {
                // another panel of this document is already asking; its
                // decision reaches this panel through the shared text
                // document and the update event it produces
                return;
            }
            try {
                let diskBytes: Uint8Array;
                try {
                    diskBytes = await vscode.workspace.fs.readFile(uri);
                } catch (error) {
                    // The watcher forwards deletes too. Nothing can be
                    // compared against a missing file; surface it once so
                    // the silence is at least visible, and let the next
                    // save re-create the file (VS Code's own contract for
                    // deleted-while-dirty documents).
                    const isFileNotFound = (error as { code?: string } | undefined)?.code === 'FileNotFound';
                    if (isFileNotFound && document.isDirty && shouldNotifyDeletedOnce(uriKey)) {
                        vscode.window.showWarningMessage(
                            i18n('ext.markdown.externalFileDeleted', parse(uri.fsPath).base));
                    }
                    return;
                }
                clearDeletedNotified(uriKey);
                const diskText = normalizeDiskText(diskBytes);
                if (diskText === undefined) {
                    return;
                }
                const bufferTexts = [
                    content,
                    document.getText().replace(/\r/g, ''),
                    ...recentBufferTexts,
                    ...collectPanelBufferTexts(uriKey),
                ];
                if (!shouldAskAboutDiskChange({ bufferTexts, diskText, isDirty: document.isDirty, acknowledgedDiskTexts })) {
                    return;
                }
                // Park saves of this document until the user has decided,
                // so autosave / Ctrl+S cannot silently overwrite the
                // external change the prompt is asking about.
                let resolveDecision: () => void = () => { };
                const decision = new Promise<void>(resolve => { resolveDecision = resolve; });
                MarkdownEditorProvider.pendingDiskDecisions.set(uri.toString(), decision);
                try {
                    const choice = await vscode.window.showInformationMessage(
                        i18n('ext.markdown.externalFileChange', parse(uri.fsPath).base),
                        'Load disk version',
                        'Keep my edits',
                    );
                    if (choice === 'Load disk version') {
                        // Release the decision BEFORE loading: loadDiskVersion
                        // calls document.save(), whose onWillSaveTextDocument
                        // would waitUntil this still-pending decision and
                        // deadlock against it.
                        resolveDecision();
                        MarkdownEditorProvider.pendingDiskDecisions.delete(uri.toString());
                        await loadDiskVersion();
                    } else {
                        // Keep my edits — dismissing the prompt (Esc) also
                        // lands here: the non-destructive branch.
                        acknowledgedDiskTexts.add(diskText);
                    }
                } finally {
                    // idempotent: promise resolution and map deletion repeat safely
                    resolveDecision();
                    MarkdownEditorProvider.pendingDiskDecisions.delete(uri.toString());
                }
            } catch {
                // the backstop must never surface its own failures
            } finally {
                endDiskChangePrompt(uriKey);
            }
            // the disk may have moved on while the prompt was up; re-check once
            void checkExternalDiskChange();
        };
        handler.on("fileChange", () => {
            void checkExternalDiskChange();
        });

        handler.on("init", async () => {
            const viewerSettings = await ViewerSettingsService.loadForWebview();
            const workspaceUri = this.getWorkspaceUriByFileUtil(uri);
            handler.emit("open", {
                content, rootPath,
                workspaceBaseUrl: workspaceUri ? webview.asWebviewUri(workspaceUri).toString().replace(/\?.+$/, '') : '',
                documentCacheId: `${uri.scheme}:${uri.toString()}`,
                pendingFragment: consumePendingBlockScroll(uri),
                shouldRestoreFocus: config.get<boolean>("restoreViewState", false),
                config: this.getMarkdownWebviewConfig(config),
                viewerSettings,
            })
            this.updateCount(content)
            this.countStatus.show()
        }).on("externalUpdate", e => {
            if (lastManualSaveTime && Date.now() - lastManualSaveTime < 800) return;
            const updatedText = e.document.getText()?.replace(/\r/g, '');
            if (content == updatedText) return;
            content = updatedText;
            this.updateCount(content)
            handler.emit("update", updatedText)
        }).on("command", (command) => {
            vscode.commands.executeCommand(command)
        }).on("openLink", async (linkUri: string) => {
            if (linkUri.startsWith('wiki:')) {
                await openWikiLink(uri, linkUri);
                return;
            }
            const localUri = parseWebviewResourceUri(linkUri, uri, this.getWorkspaceUriByFileUtil(uri));
            if (localUri) {
                vscode.commands.executeCommand('vscode.open', localUri, { preview: false });
            } else {
                vscode.env.openExternal(vscode.Uri.parse(linkUri));
            }
        }).on("codeMirrorTheme", (theme: string) => {
            const validThemes = [
                "Auto", "default",
                "Github", "Solarized Light", "Material Light", "Quiet Light", "One Light",
                "Dracula", "Monokai", "One Dark", "Solarized Dark", "Material Dark",
            ];
            if (validThemes.includes(theme)) {
                Global.updateConfig("codeMirrorTheme", theme === "default" ? "Auto" : theme);
            }
        }).on("editorTheme", (theme: string) => {
            const validThemes = [
                "Auto", "Light", "Solarized", "Warm Light", "Dim Light",
                "One Dark", "Github Dark", "Nord", "Monokai", "Dracula",
            ];
            if (validThemes.includes(theme)) {
                Global.updateConfig("editorTheme", theme);
            }
        }).on("mermaidTheme", (theme: string) => {
            const validThemes = [
                "Auto", "Light", "Forest", "Ocean", "Sunset",
                "Dark", "Dracula", "Monokai", "Nord",
            ];
            if (validThemes.includes(theme)) {
                Global.updateConfig("mermaidTheme", theme);
            }
        }).on("editMode", (mode: string) => {
            if (mode === "wysiwyg" || mode === "ir") {
                Global.updateConfig("editMode", mode);
            }
        }).on("img", async (payload) => {
            const imgData: string = typeof payload === 'string' ? payload : payload.data;
            const ext: string = typeof payload === 'string' ? 'png' : (payload.ext || 'png');
            const imageMarkdown = await this.saveImageAndBuildMarkdown(uri, imgData, ext);
            if (imageMarkdown) {
                handler.emit('insertImageMarkdown', imageMarkdown);
            }
        }).on("insertImage", async () => {
            const files = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { Images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'] },
                title: i18n('ext.markdown.selectImage'),
            });
            if (!files || files.length === 0) return;
            const sourceUri = files[0];
            const ext = parse(sourceUri.fsPath).ext.replace('.', '').toLowerCase() || 'png';
            const fileBytes = await vscode.workspace.fs.readFile(sourceUri);
            const imageMarkdown = await this.saveImageAndBuildMarkdown(uri, fileBytes, ext);
            if (imageMarkdown) {
                handler.emit('insertImageMarkdown', imageMarkdown);
            }
        }).on("editInVSCode", (full: boolean) => {
            const side = full ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
            vscode.commands.executeCommand('vscode.openWith', uri, "default", side);
        }).on("showInFolder", () => {
            if (vscode.env.uiKind !== vscode.UIKind.Web) {
                vscode.commands.executeCommand('revealFileInOS', uri);
            }
        }).on("save", (newContent) => {
            if (lastManualSaveTime && Date.now() - lastManualSaveTime < 800) return;
            scheduleDocumentSync(newContent);
        }).on("doSave", async (saveContent) => {
            lastManualSaveTime = Date.now();
            pendingDocumentSync = saveContent;
            content = saveContent;
            await flushDocumentSync();
            this.updateCount(content);
            vscode.commands.executeCommand('workbench.action.files.save');
        }).on("export", (option) => {
            vscode.commands.executeCommand('workbench.action.files.save');
            new MarkdownService(this.context).exportMarkdown(uri, option)
        }).on('developerTool', () => {
            vscode.commands.executeCommand('workbench.action.toggleDevTools')
        }).on('openAbout', () => {
        }).on('openSponsor', () => {
            vscode.commands.executeCommand(
                'workbench.extensions.action.showExtensionsWithIds',
                ['cweijan.vscode-database-client2'],
            );
        }).on('openExternal', (url: string) => {
            if (url) {
                vscode.env.openExternal(vscode.Uri.parse(url));
            }
        }).on('queryAIAvailable', () => {
            void this.notifyAIAvailable(handler);
        }).on('queryVSCodeModels', async () => {
            const lm = (vscode as any).lm;
            if (typeof lm?.selectChatModels !== 'function') {
                handler.emit('vscodeModels', []);
                return;
            }
            try {
                const models: any[] = await lm.selectChatModels();
                handler.emit('vscodeModels', (models ?? []).map((m: any) => ({
                    id: m.id,
                    name: m.name,
                    family: m.family,
                    vendor: m.vendor,
                })));
            } catch {
                handler.emit('vscodeModels', []);
            }
        }).on('aiPolish', async (payload: { markdown: string; options?: any }) => {
            await this.handleAIPolish(handler, payload.markdown, payload.options);
        }).on('aiPolishCancel', () => {
            this.cancelAIPolish();
        }).on('telemetry', (payload: { event: string; properties?: Record<string, string | number | boolean> }) => {
            const properties = {
                ...this.getMarkdownTelemetryProps(),
                ...Object.fromEntries(
                    Object.entries(payload.properties ?? {}).map(([key, value]) => [key, String(value)]),
                ),
            };
            TelemetryService.get()?.trackEvent(payload.event, properties);
        }).on('syncViewerSettings', async (settings) => {
            if (await ViewerSettingsService.exists()) {
                await ViewerSettingsService.writeFromVditor(settings);
            }
        }).on('editViewerSettings', async (settings) => {
            await ViewerSettingsService.createAndOpen(settings);
        })

        const basePath = Global.getConfig('workspacePathAsImageBasePath') ?
            vscode.Uri.file(getWorkspacePath(folderPath)) : folderPath;
        const baseUrl = webview.asWebviewUri(basePath).toString().replace(/\?.+$/, '').replace('https://git', 'https://file');
        const indexHtml = await readExtensionText(this.context, 'resource', 'markdown', 'index.html');
        webview.html = Util.buildPath(
            indexHtml.replace("{{baseUrl}}", baseUrl), webview, contextUri
        );
    }

    private cancelAIPolish() {
        this.aiCancellationSource?.cancel();
        this.aiAbortController?.abort();
    }

    private async notifyAIAvailable(handler: Handler) {
        const lm = (vscode as any).lm;
        const available = typeof lm?.selectChatModels === 'function';
        handler.emit('aiAvailable', available);
    }

    private buildPolishPrompt(markdown: string, options?: any): string {
        const parts: string[] = [];
        parts.push('You are a writing assistant.');
        if (options?.prompt) {
            parts.push(options.prompt);
        } else {
            parts.push('Polish the following Markdown text: improve clarity, fix grammar, and enhance readability.');
        }
        if (options?.goal) {
            parts.push(`Focus on: ${options.goal}`);
        }
        parts.push(buildAIOutputLanguageInstruction(options?.outputLanguage, options?.uiLanguage));
        parts.push('Return ONLY the polished Markdown with no extra commentary.\n\n' + markdown);
        return parts.join('\n');
    }

    private async handleAIPolish(handler: Handler, markdown: string, options?: any) {
        const engine = options?.engine ?? 'vscode';

        this.cancelAIPolish();
        this.aiCancellationSource = new vscode.CancellationTokenSource();
        this.aiAbortController = new AbortController();

        if (engine === 'custom') {
            await this.handleCustomAIPolish(handler, markdown, options);
            return;
        }

        const lm = (vscode as any).lm;
        if (typeof lm?.selectChatModels !== 'function') {
            vscode.window.showWarningMessage(i18n('ext.markdown.aiRequiresVscode'));
            handler.emit('aiPolishResult', markdown);
            return;
        }
        try {
            let model: any;
            if (options?.vscodeModelId) {
                const all: any[] = await lm.selectChatModels();
                model = all?.find((m: any) => m.id === options.vscodeModelId);
            }
            if (!model) {
                let models: any[] = await lm.selectChatModels({ family: 'gpt-4o' });
                if (!models || models.length === 0) {
                    models = await lm.selectChatModels();
                }
                if (!models || models.length === 0) {
                    vscode.window.showWarningMessage(i18n('ext.markdown.noAiModel'));
                    handler.emit('aiPolishEnd');
                    return;
                }
                model = models[0];
            }
            const LanguageModelChatMessage = (vscode as any).LanguageModelChatMessage;
            const messages = [LanguageModelChatMessage.User(this.buildPolishPrompt(markdown, options))];
            const token = this.aiCancellationSource.token;
            const response = await model.sendRequest(messages, {}, token);
            for await (const chunk of response.text) {
                if (token.isCancellationRequested) break;
                handler.emit('aiPolishChunk', chunk);
            }
            if (!token.isCancellationRequested) {
                handler.emit('aiPolishEnd');
            }
        } catch (err: any) {
            if (this.aiCancellationSource?.token.isCancellationRequested) return;
            vscode.window.showErrorMessage(i18n('ext.markdown.aiPolishFailed', String(err?.message ?? err)));
            handler.emit('aiPolishEnd');
        }
    }

    private async handleCustomAIPolish(handler: Handler, markdown: string, options: any) {
        const url = options?.customUrl?.trim();
        if (!url) {
            vscode.window.showWarningMessage(i18n('ext.markdown.customAiUrlRequired'));
            handler.emit('aiPolishResult', markdown);
            return;
        }
        try {
            await streamCustomAI({
                url,
                apiKey: options?.customKey?.trim(),
                model: options?.customModel?.trim(),
                format: options?.customApiFormat,
                prompt: this.buildPolishPrompt(markdown, options),
                signal: this.aiAbortController?.signal,
                onChunk: (chunk: string) => {
                    handler.emit('aiPolishChunk', chunk);
                },
            });
            handler.emit('aiPolishEnd');
        } catch (err: any) {
            if (err?.name === 'AbortError') return;
            vscode.window.showErrorMessage(i18n('ext.markdown.customAiPolishFailed', String(err?.message ?? err)));
            handler.emit('aiPolishEnd');
        }
    }

    private getMarkdownWebviewConfig(configuration: vscode.WorkspaceConfiguration) {
        const markdownConfiguration = vscode.workspace.getConfiguration("markdown");
        return {
            editMode: configuration.get<string>("editMode", "wysiwyg"),
            editorTheme: configuration.get<string>("editorTheme", "Auto"),
            codeMirrorTheme: configuration.get<string>("codeMirrorTheme", "Auto"),
            mermaidTheme: configuration.get<string>("mermaidTheme", "Auto"),
            markdown: {
                math: {
                    macros: markdownConfiguration.get<Record<string, string>>("math.macros", {}),
                },
            },
            language: vscode.env.language,
            isWeb: this.options.isWeb,
            isDev: this.context.extensionMode === vscode.ExtensionMode.Development,
        };
    }

    private async saveImageAndBuildMarkdown(
        documentUri: vscode.Uri,
        imageData: string | Uint8Array,
        ext: string,
    ): Promise<string | undefined> {
        const { relPath, fullPath } = adjustImgPath(documentUri, ext);
        const imagePath = isAbsolute(fullPath) ? fullPath : `${resolve(documentUri.fsPath, "..")}/${relPath}`.replace(/\\/g, "/");
        const imageUri = vscode.Uri.file(imagePath);
        await ensureParentDirectory(imageUri);
        const bytes = typeof imageData === 'string'
            ? Uint8Array.from(Buffer.from(imageData, 'binary'))
            : imageData;
        await vscode.workspace.fs.writeFile(imageUri, bytes);
        const fileName = parse(relPath).name;
        const adjustRelPath = await MarkdownService.imgExtGuide(imagePath, relPath);
        return `![${fileName}](${adjustRelPath})`;
    }

    private updateCount(content: string) {
        this.countStatus.text = i18n('ext.markdown.statusBar', String(content.split(/\r\n|\r|\n/).length), String(content.length))
    }

    private updateTextDocument(document: vscode.TextDocument, content: string) {
        const normalized = content.replace(/\r/g, '');
        if (document.getText().replace(/\r/g, '') === normalized) {
            return Promise.resolve(true);
        }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), normalized);
        return vscode.workspace.applyEdit(edit);
    }

}
