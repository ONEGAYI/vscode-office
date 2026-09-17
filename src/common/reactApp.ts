import axios from 'axios';
import * as vscode from 'vscode';
import { extensionResource, getExtensionUri, readExtensionText } from './extensionResource';
import { IconService } from '../service/icon/iconService';
import { resolveWebviewContent } from './webviewContent';
import { Output } from './Output';

interface ViewOption {
    route: string;
    fileName?: string;
    gitHistoryInit?: import('../gitHistory/util/gitHistoryInitPayload').GitHistoryEmbeddedInit;
}

export class ReactApp {

    private static context: vscode.ExtensionContext;
    private static webviewUri: vscode.Uri;
    public static IS_DEV = false;

    public static init(context: vscode.ExtensionContext) {
        this.context = context;
        this.webviewUri = extensionResource(context, 'out', 'webview');
        this.IS_DEV = context.extensionMode == vscode.ExtensionMode.Development;
    }

    public static async view(webview: vscode.Webview, option: ViewOption) {
        const content = await this.resolveContent();
        const iconConfig = IconService.getInstance().getWebviewConfig(this.context, webview);
        const sponsorBaseUrl = webview.asWebviewUri(
            extensionResource(this.context, 'resource', 'sponsor')
        ).toString();
        webview.html = this.buildPath(content, webview)
            .replace(`{{configs}}`, JSON.stringify({
                ...option,
                ...iconConfig,
                sponsorBaseUrl,
                language: vscode.env.language,
                config: vscode.workspace.getConfiguration('vscode-office')
            }));
    }

    private static async resolveContent() {
        const devServerUrl = 'http://127.0.0.1:5739';
        return resolveWebviewContent({
            isDev: this.IS_DEV,
            fetchDev: async () => {
                try {
                    const data: string = (await axios.get(`${devServerUrl}/index.html`, { transformResponse: [], timeout: 3000 })).data;
                    return data.replace(/(["'])\/(?=(?:@|src\/|index\.html\?))/g, `$1${devServerUrl}/`);
                } catch (error) {
                    Output.debug(`Webview dev server unreachable (${(error as Error)?.message}); serving the last production build from out/webview`);
                    throw error;
                }
            },
            readProd: () => readExtensionText(this.context, 'out', 'webview', 'index.html'),
        });
    }

    private static buildPath(content: { html: string; fromDevServer: boolean }, webview: vscode.Webview): string {
        const baseUrl = ReactApp.getBaseUrl(webview, content.fromDevServer);
        return content.html.replace('<base href="/">', `<base href="${baseUrl}/">`);
    }

    private static getBaseUrl(webview: vscode.Webview, fromDevServer: boolean) {
        if (fromDevServer) {
            return `http://127.0.0.1:5739`;
        }
        return webview.asWebviewUri(this.webviewUri).toString();
    }

    public static getExtensionUri(): vscode.Uri {
        return getExtensionUri(this.context);
    }

}