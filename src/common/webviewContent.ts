export interface WebviewContent {
    html: string;
    fromDevServer: boolean;
}

export interface WebviewContentSource {
    isDev: boolean;
    fetchDev(): Promise<string>;
    readProd(): Promise<string>;
}

/**
 * Picks the webview HTML source. In dev mode the vite dev server is the
 * source of truth, but it may be unreachable (not started yet, or its port
 * blocked by OS port reservations). Serving the last production build keeps
 * the viewer working instead of failing every office file open; callers must
 * honor `fromDevServer` when picking the base URL so assets resolve
 * consistently with the chosen source.
 */
export async function resolveWebviewContent(source: WebviewContentSource): Promise<WebviewContent> {
    if (source.isDev) {
        try {
            return { html: await source.fetchDev(), fromDevServer: true };
        } catch (error) {
            // fall through to the production build
        }
    }
    return { html: await source.readProd(), fromDevServer: false };
}
