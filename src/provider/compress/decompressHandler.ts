import { Handler } from "@/common/handler";
import { execFile } from "child_process";
import { existsSync, rm } from "fs";
import { platform, tmpdir } from "os";
import { resolve } from "path";
import { Uri, commands } from "vscode";

export function handlerCommonDecompress(uri: Uri, handler: Handler) {
    const decompressPath = `${tmpdir()}/officeViewer-decompress-${new Date().getTime()}`;
    handler
        .on('showInExplorer', () => {
            const path = uri.fsPath;
            if (platform() == 'win32') {
                execFile('explorer.exe', ['/select,', resolve(path)]);
            } else if (platform() == 'darwin') {
                execFile('open', ['-R', resolve(path)]);
            } else {
                commands.executeCommand('vscode.open', Uri.file(uri.fsPath));
            }
        }).on('dispose', () => {
            if (existsSync(decompressPath)) rm(decompressPath, { recursive: true, force: true }, null);
        });

    return decompressPath;
}
