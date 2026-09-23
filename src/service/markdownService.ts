import { adjustImgPath } from "@/common/fileUtil";
import { Output } from "@/common/Output";
import { spawn } from 'child_process';
import chromeFinder from 'chrome-finder';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readSync, renameSync } from 'fs';
import { homedir } from 'os';
import path, { dirname, extname, isAbsolute, join, parse } from 'path';
import * as vscode from 'vscode';
import { Holder } from './markdown/holder';
import { convertMd } from "./markdown/markdown-pdf";
import { detectClipboardImageExtension } from './markdown/imageSignature';
import { parseDiffLabel, planSwitchEditor, resolveUnknownDiffSides } from './markdown/switchEditorPlanner';
import { openMarkdownDiff, openTextDiff } from './markdown/markdownTextDiff';
import { Global, i18n } from "@/common/global";

export type ExportType = 'pdf' | 'html' | 'docx';

interface ExportOption {
    type?: ExportType;
    withoutOutline?: boolean;
}

export class MarkdownService {

    constructor(private context: vscode.ExtensionContext) {
    }

    /**
     * export markdown to another type
     * @param type pdf, html, docx 
     */
    public async exportMarkdown(uri: vscode.Uri, option: ExportOption = {}) {
        const { type = 'pdf' } = option;
        try {
            if (type != 'html') { // html导出速度快, 无需等待
                vscode.window.showInformationMessage(i18n('ext.markdown.exportStart', type))
            }
            await convertMd({ markdownFilePath: uri.fsPath, config: this.getConfig(option) })
            vscode.window.showInformationMessage(i18n('ext.markdown.exportSuccess', type))
        } catch (error) {
            Output.log(error)
        }
    }

    public getConfig(option: ExportOption) {
        const top = Global.getConfig("pdfMarginTop")
        const { type = 'pdf', withoutOutline = false } = option;
        return {
            type,
            "styles": [],
            withoutOutline,
            // chromium path
            "executablePath": this.getChromiumPath(),
            // puppeteer launch args (useful for Linux servers running as root)
            "puppeteerArgs": this.getPuppeteerArgs(),
            // Set `true` to convert `\n` in paragraphs into `<br>`.
            "breaks": false,
            // pdf print option
            "printBackground": true,
            format: "A4",
            margin: { top }
        };
    }

    private getPuppeteerArgs(): string[] {
        // Custom args from settings
        const customArgs = Global.getConfig<string[]>("puppeteerArgs");
        if (customArgs && customArgs.length > 0) {
            return customArgs;
        }
        // On Linux, running as root requires --no-sandbox
        if (process.platform === 'linux') {
            try {
                const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
                if (uid === 0) {
                    return ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
                }
            } catch {
                // getuid not available on this platform
            }
        }
        return [];
    }

    private paths: string[] = [
        // Windows
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge Dev\\Application\\msedge.exe",
        join(homedir(), "AppData\\Local\\Microsoft\\Edge SxS\\Application\\msedge.exe"),
        // macOS
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        // Linux
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
        "/usr/bin/microsoft-edge",
    ]

    private getChromiumPath() {
        const chromiumPath = Global.getConfig<string>("chromiumPath")
        const paths = [chromiumPath, ...this.paths]
        for (const path of paths) {
            if (existsSync(path)) {
                console.debug(`using chromium path is ${path}`)
                return path;
            }
        }
        try {
            const chromePath = chromeFinder();
            console.debug(`using chrome path is ${chromePath}`)
            return chromePath;
        } catch (e) {
            const msg = i18n('ext.markdown.noChromium');
            vscode.window.showErrorMessage(msg)
            throw new Error(msg)
        }
    }

    public async loadClipboardImage() {

        const document = vscode.window.activeTextEditor?.document || Holder.activeDocument
        if (await vscode.env.clipboard.readText()) {
            vscode.commands.executeCommand("editor.action.clipboardPasteAction")
            return
        }

        if (!document || document.isUntitled || document.isClosed) {
            return
        }

        const uri = document.uri;
        const info = adjustImgPath(uri, 'png'), { fullPath } = info;
        let { relPath } = info;
        const imagePath = isAbsolute(fullPath) ? fullPath : `${dirname(uri.fsPath)}/${relPath}`.replace(/\\/g, "/");
        this.createImgDir(imagePath);
        this.saveClipboardImageToFileAndGetPath(imagePath, async (savedImagePath) => {
            if (!savedImagePath) return;
            if (savedImagePath === 'no image') {
                vscode.window.showErrorMessage(i18n('ext.markdown.noClipboardImage'));
                return;
            }
            this.copyFromPath(savedImagePath, imagePath);
            const editor = vscode.window.activeTextEditor;
            const imgName = parse(relPath).name;
            relPath = await MarkdownService.imgExtGuide(imagePath, relPath);
            if (editor) {
                editor?.edit(edit => {
                    const current = editor.selection;
                    if (current.isEmpty) {
                        edit.insert(current.start, `![${imgName}](${relPath})`);
                    } else {
                        edit.replace(current, `![${imgName}](${relPath})`);
                    }
                });
            }
        })
    }

    public static async imgExtGuide(absPath: string, relPath: string) {
        const oldExt = extname(absPath)
        const header = Buffer.alloc(64);
        const fd = openSync(absPath, 'r');
        let readLength: number;
        try {
            readLength = readSync(fd, header, 0, header.length, 0);
        } finally {
            closeSync(fd);
        }
        const ext = detectClipboardImageExtension(header.subarray(0, readLength))
            ?? (oldExt.replace(/^\./, '') || 'png');
        if (oldExt != `.${ext}`) {
            relPath = relPath.replace(oldExt, `.${ext}`)
            renameSync(absPath, absPath.replace(oldExt, `.${ext}`))
        }
        return relPath
    }

    /**
     * 如果粘贴板内是复制了一个文件, 取得路径进行复制
     */
    private copyFromPath(savedImagePath: string, targetPath: string) {
        if (savedImagePath.startsWith("copied:")) {
            const copiedFile = savedImagePath.replace("copied:", "");
            if (lstatSync(copiedFile).isDirectory()) {
                vscode.window.showErrorMessage(i18n('ext.markdown.noPasteDirectory'));
            } else {
                copyFileSync(copiedFile, targetPath);
            }
        }
    }

    private createImgDir(imagePath: string) {
        const dir = path.dirname(imagePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }

    private saveClipboardImageToFileAndGetPath(imagePath: string, cb: (value: string) => void) {
        if (!imagePath) return;
        const platform = process.platform;
        if (platform === 'win32') {
            // Windows
            const scriptPath = path.join(this.context.extensionPath, '/lib/pc.ps1');
            const powershell = spawn('powershell', [
                '-noprofile',
                '-noninteractive',
                '-nologo',
                '-sta',
                '-executionpolicy', 'unrestricted',
                '-windowstyle', 'hidden',
                '-file', scriptPath,
                imagePath
            ]);
            powershell.on('exit', function (code, signal) {
            });
            powershell.stdout.on('data', function (data) {
                cb(data.toString().trim());
            });
        } else if (platform === 'darwin') {
            // Mac
            const scriptPath = path.join(this.context.extensionPath, './lib/mac.applescript');
            const ascript = spawn('osascript', [scriptPath, imagePath]);
            ascript.on('exit', function (code, signal) {
            });
            ascript.stdout.on('data', function (data) {
                cb(data.toString().trim());
            });
        } else {
            // Linux 
            const scriptPath = path.join(this.context.extensionPath, './lib/linux.sh');

            const ascript = spawn('sh', [scriptPath, imagePath]);
            ascript.on('exit', function (code, signal) {
            });
            ascript.stdout.on('data', function (data) {
                const result = data.toString().trim();
                if (result == "no xclip") {
                    vscode.window.showInformationMessage(i18n('ext.markdown.installXclip'));
                    return;
                }
                cb(result);
            });
        }
    }

    public async switchEditor(uri?: vscode.Uri) {
        // The extension still supports VS Code versions predating the Tab API.
        const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
        const tabInput = activeTab?.input;
        let plan = planSwitchEditor({
            commandUri: uri?.toString(),
            activeTextEditorUri: vscode.window.activeTextEditor?.document.uri.toString(),
            activeTabDiff: vscode.TabInputTextDiff && tabInput instanceof vscode.TabInputTextDiff && activeTab
                ? {
                    original: tabInput.original.toString(),
                    modified: tabInput.modified.toString(),
                    label: activeTab.label,
                }
                : undefined,
        });
        // Diff tabs with custom editors on either side expose no
        // original/modified pair to the extension API (opaque input), so the
        // planner above would degrade them into a single-file open. Recover
        // the pair from the label and open documents, with an optional side
        // URI from the title command. Standalone tabs are not required.
        if (activeTab && parseDiffLabel(activeTab.label)
            && !(tabInput instanceof vscode.TabInputTextDiff)
            && !(tabInput instanceof vscode.TabInputText)
            && !(tabInput instanceof vscode.TabInputCustom)) {
            const sides = resolveUnknownDiffSides(activeTab.label, uri?.toString(), this.collectOpenDocumentInfos());
            if (sides) {
                plan = { action: 'diff', viewType: 'default', ...sides, label: activeTab.label };
            } else {
                await vscode.window.showWarningMessage('Cannot identify both Markdown comparison files. Keep the comparison open and retry after opening its source files.');
                return;
            }
        }
        if (!plan) return;
        if (plan.action === 'diff') {
            const openDiff = plan.viewType === 'default' ? openTextDiff : openMarkdownDiff;
            await openDiff(vscode.Uri.parse(plan.original), vscode.Uri.parse(plan.modified), plan.label);
            // VS Code 1.86 can revert a dirty native document when closing
            // its tab even though a custom comparison now displays it.
            // Retain that tab until saved; subsequent switches reuse it.
            const hasUnsavedChanges = vscode.workspace.textDocuments.some(document => document.isDirty
                && (document.uri.toString() === plan.original || document.uri.toString() === plan.modified));
            if (activeTab && !activeTab.isDirty && !hasUnsavedChanges
                && vscode.window.tabGroups.activeTabGroup.activeTab !== activeTab) {
                try {
                    await vscode.window.tabGroups.close(activeTab);
                } catch {
                    // The new text diff remains available either way.
                }
            }
        } else {
            await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.parse(plan.uri), plan.viewType);
        }
    }

    private collectOpenDocumentInfos() {
        const infos: { label: string; uri?: string }[] = [];
        // Custom diff documents stay open even after their standalone tabs
        // close. They also cover title commands without a resource argument.
        for (const document of vscode.workspace.textDocuments) {
            infos.push({ label: '', uri: document.uri.toString() });
        }
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const input = tab.input;
                infos.push({
                    label: tab.label,
                    uri: input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom
                        ? input.uri.toString()
                        : undefined,
                });
            }
        }
        return infos;
    }

}
