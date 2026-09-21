import { DownOutlined, MoonOutlined, RightOutlined, SunOutlined } from "@ant-design/icons";
import { Alert, Button, Spin } from "antd";
import { DocxEditor, type DocxEditorRef } from "@eigenpal/docx-editor-react";
import "@eigenpal/docx-editor-react/styles.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { handler, vscodeApi } from "../../util/vscode";
import { loadOfficeBuffer } from "../../util/loadOfficeContent";
import SponsorBar from "../components/SponsorBar";
import "./Word.css";
import { installEmfPreviews } from "./emfPreview";
import { renderEmfPreview } from "./emfRenderer";
import { hasEmbeddedOfficeObjects } from "./embeddedObjects";
import { preparePreservedBody, type PreservedBodySession } from "./preservedBody";
import { createBodyEditGuard, insertBodyParagraph, moveBodyBlock } from "./bodyEditGuard";
import type { EditorView } from "prosemirror-view";

type WordColorMode = "light" | "adaptive";

const WORD_COLOR_MODE_KEY = "office-word-color-mode";

function loadWordColorMode(): WordColorMode {
    const state = vscodeApi?.getState?.() as { wordColorMode?: WordColorMode } | undefined;
    if (state?.wordColorMode === "light" || state?.wordColorMode === "adaptive") {
        return state.wordColorMode;
    }
    try {
        const saved = localStorage.getItem(WORD_COLOR_MODE_KEY);
        if (saved === "light" || saved === "adaptive") {
            return saved;
        }
    } catch { }
    return "light";
}

function saveWordColorMode(mode: WordColorMode) {
    try {
        localStorage.setItem(WORD_COLOR_MODE_KEY, mode);
    } catch { }
    if (vscodeApi?.setState) {
        const prev = (vscodeApi.getState?.() ?? {}) as Record<string, unknown>;
        vscodeApi.setState({ ...prev, wordColorMode: mode });
    }
}

interface WordOpenPayload {
    path?: string;
    buffer?: number[];
    error?: string;
    readOnly?: boolean;
    fileName?: string;
    documentCacheId?: string;
    nonce?: number;
}

export default function Word() {
    const editorRef = useRef<DocxEditorRef>(null);
    const editorViewRef = useRef<EditorView | null>(null);
    const viewerRef = useRef<HTMLDivElement>(null);
    const readOnlyRef = useRef(false);
    const saveBlockedRef = useRef(false);
    const sessionRef = useRef<PreservedBodySession | null>(null);
    const fileReadOnlyRef = useRef(false);
    const capturingRef = useRef(0);
    const savingRef = useRef(false);
    const [bodySession, setBodySession] = useState<PreservedBodySession | null>(null);
    const [bodyReady, setBodyReady] = useState(false);
    const [bannerCollapsed, setBannerCollapsed] = useState(false);
    const [editNotice, setEditNotice] = useState<string | null>(null);
    const loadSequence = useRef(0);
    const [hasEmbeddedObjects, setHasEmbeddedObjects] = useState(false);
    const [colorMode, setColorMode] = useState<WordColorMode>(loadWordColorMode);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [readOnly, setReadOnly] = useState(false);
    const [documentBuffer, setDocumentBuffer] = useState<ArrayBuffer | undefined>(undefined);
    const [documentKey, setDocumentKey] = useState("");
    const [fileName, setFileName] = useState("");
    const [commentsSidebarOpen, setCommentsSidebarOpen] = useState(false);
    const skipCommentsAutoOpenRef = useRef(true);

    const adaptiveColorMode = colorMode === "adaptive";
    const bodyPlugins = useMemo(() => bodySession ? [createBodyEditGuard(bodySession.editableIds, () => {
        // The persistent banner explains protection; reserve alerts for actual errors.
    })] : [], [bodySession]);

    useEffect(() => {
        if (!viewerRef.current) return;
        return installEmfPreviews(viewerRef.current, renderEmfPreview);
    }, [documentKey]);

    const toggleColorMode = () => {
        setColorMode((prev) => {
            const next: WordColorMode = prev === "adaptive" ? "light" : "adaptive";
            saveWordColorMode(next);
            return next;
        });
    };

    const emitSave = useCallback(async (buffer: ArrayBuffer) => {
        if (saveBlockedRef.current || capturingRef.current || savingRef.current) return;
        const sequence = loadSequence.current;
        const session = sessionRef.current;
        savingRef.current = true;
        try {
            // Toolbar saves can use the library's selective path. Use the same full
            // serialization as capture so layout edits are compared consistently.
            const full = session ? await editorRef.current?.save({ selective: false }) : buffer;
            if (!full) throw new Error('未能生成正文保存数据');
            const saved = session ? await session.save(full) : full;
            if (sequence !== loadSequence.current) return;
            handler.emit("save", Array.from(new Uint8Array(saved)));
            setEditNotice(null);
        } catch (e) {
            if (sequence === loadSequence.current) setEditNotice(e instanceof Error ? e.message : String(e));
        } finally { savingRef.current = false; }
    }, []);

    const handleSave = useCallback(async () => {
        if (saveBlockedRef.current) return;
        try { await editorRef.current?.save(); } // save() invokes onSave for both host and toolbar paths.
        catch (e) { setEditNotice(e instanceof Error ? e.message : String(e)); }
    }, []);

    const initializeBodySave = useCallback(() => {
        const session = sessionRef.current;
        if (!session || session.ready || capturingRef.current) return;
        const sequence = loadSequence.current;
        capturingRef.current = sequence;
        void (async () => {
            try {
                // Let the imperative ref and document state settle after EditorView creation.
                await new Promise(resolve => setTimeout(resolve, 0));
                if (sequence !== loadSequence.current) return;
                const baseline = await editorRef.current?.save({ selective: false });
                if (!baseline) throw new Error('未能准备正文保存，文档仍保持只读');
                await session.capture(baseline);
                if (sequence !== loadSequence.current) return;
                saveBlockedRef.current = false;
                readOnlyRef.current = fileReadOnlyRef.current;
                setReadOnly(fileReadOnlyRef.current);
                setBodyReady(true);
            } catch (e) {
                if (sequence === loadSequence.current) setEditNotice(String(e));
            } finally { if (capturingRef.current === sequence) capturingRef.current = 0; }
        })();
    }, []);

    const loadDocument = useCallback(async (payload: WordOpenPayload) => {
        const sequence = ++loadSequence.current;
        setLoading(true);
        setError(null);
        setEditNotice(null);
        setBodyReady(false);
        sessionRef.current = null;
        editorViewRef.current = null;
        capturingRef.current = 0;
        setDocumentBuffer(undefined);
        // Block stale callbacks while a different document is being loaded.
        saveBlockedRef.current = true;

        try {
            const buffer = await loadOfficeBuffer(payload);
            const containsObjects = await hasEmbeddedOfficeObjects(buffer);
            const session = containsObjects ? await preparePreservedBody(buffer) : null;
            if (sequence !== loadSequence.current) return;
            sessionRef.current = session;
            setBodySession(session);
            fileReadOnlyRef.current = payload.readOnly === true;
            saveBlockedRef.current = containsObjects;
            setHasEmbeddedObjects(containsObjects);
            const fileReadOnly = payload.readOnly === true || containsObjects;
            readOnlyRef.current = fileReadOnly;
            setReadOnly(fileReadOnly);
            setFileName(payload.fileName ?? "");
            setDocumentKey(`${payload.documentCacheId ?? ""}-${payload.nonce ?? Date.now()}`);
            skipCommentsAutoOpenRef.current = true;
            setCommentsSidebarOpen(false);
            setDocumentBuffer(session?.buffer ?? buffer);
        } catch (e) {
            if (sequence === loadSequence.current) setError(e instanceof Error ? e.message : "Failed to load document");
        } finally {
            if (sequence === loadSequence.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        handler
            .on("open", (payload: WordOpenPayload) => {
                void loadDocument(payload);
            })
            .emit("init");
    }, [loadDocument]);

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.code === "KeyS") {
                e.preventDefault();
                e.stopPropagation();
                void handleSave();
            }
        };
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [handleSave]);

    const renderedSequence = loadSequence.current;
    const onEditorViewReady = useCallback((view: EditorView) => {
        if (renderedSequence === loadSequence.current) {
            editorViewRef.current = view;
            initializeBodySave();
        }
    }, [renderedSequence, initializeBodySave]);
    return (
        <div ref={viewerRef} className={`word-viewer${adaptiveColorMode ? " word-viewer--vscode-theme" : ""}`}>
            <button
                type="button"
                className="dark-mode-toggle"
                title={adaptiveColorMode ? "切换亮色" : "切换暗色（跟随 VS Code 主题）"}
                aria-label={adaptiveColorMode ? "Switch to light mode" : "Switch to adaptive dark mode"}
                onClick={toggleColorMode}
            >
                {adaptiveColorMode ? <SunOutlined /> : <MoonOutlined />}
            </button>
            <Spin spinning={loading} fullscreen />
            {error && <Alert type="error" message={error} showIcon style={{ margin: 16 }} />}
            {editNotice && <Alert type="warning" message={editNotice} showIcon closable onClose={() => setEditNotice(null)} />}
            {hasEmbeddedObjects && !loading && !error && documentBuffer && (
                <div className={`word-readonly-banner word-embedded-banner${bannerCollapsed ? ' word-embedded-banner--collapsed' : ''}`} data-office-body-ready={bodyReady ? 'true' : 'false'}>
                    <button
                        type="button"
                        className="word-banner-toggle"
                        aria-label={bannerCollapsed ? '展开嵌入提示' : '折叠嵌入提示'}
                        title={bannerCollapsed ? '展开嵌入提示' : '折叠嵌入提示'}
                        aria-expanded={!bannerCollapsed}
                        aria-controls="word-embedded-details"
                        onClick={() => setBannerCollapsed(value => !value)}
                    >{bannerCollapsed ? <RightOutlined /> : <DownOutlined />}</button>
                    {bannerCollapsed && <span className="word-banner-summary">{!bodyReady ? '正在准备正文编辑…' : readOnly ? '只读文档' : '嵌入块已保护 · 正文可编辑'}</span>}
                    <div id="word-embedded-details" className="word-banner-details" hidden={bannerCollapsed}>
                    {!bodyReady ? '正在准备保留嵌入对象的正文编辑，暂时只读。' : readOnly ? '此文件为只读来源，当前仅供阅读。' : '正文可增删段落；嵌入块和复杂内容仅支持整块移动，不可修改内部内容或删除。点击对象或段落后使用下方按钮。'}
                    {bodyReady && !readOnly && <div role="toolbar" aria-label="段落与嵌入块布局">
                        <Button onMouseDown={e => e.preventDefault()} onClick={() => { if (editorViewRef.current) insertBodyParagraph(editorViewRef.current, -1); }}>前插段落</Button>
                        <Button onMouseDown={e => e.preventDefault()} onClick={() => { if (editorViewRef.current) insertBodyParagraph(editorViewRef.current, 1); }}>后插段落</Button>
                        <Button onMouseDown={e => e.preventDefault()} onClick={() => { if (editorViewRef.current) moveBodyBlock(editorViewRef.current, -1); }}>块上移</Button>
                        <Button onMouseDown={e => e.preventDefault()} onClick={() => { if (editorViewRef.current) moveBodyBlock(editorViewRef.current, 1); }}>块下移</Button>
                    </div>}
                    </div>
                </div>
            )}
            {readOnly && !hasEmbeddedObjects && !loading && !error && documentBuffer && (
                <div className="word-readonly-banner">Read-only — edits will be saved to a new file</div>
            )}
            {documentBuffer && !loading && !error && (
                <>
                    <DocxEditor
                        key={documentKey}
                        ref={editorRef}
                        className="word-editor"
                        documentBuffer={documentBuffer}
                        externalPlugins={bodyPlugins}
                        onEditorViewReady={onEditorViewReady}
                        documentName={fileName}
                        documentNameEditable={false}
                        readOnly={readOnly}
                        mode={readOnly ? "viewing" : "editing"}
                        commentsSidebarOpen={commentsSidebarOpen}
                        onCommentsSidebarOpenChange={(open) => {
                            if (open && skipCommentsAutoOpenRef.current) {
                                skipCommentsAutoOpenRef.current = false;
                                return;
                            }
                            setCommentsSidebarOpen(open);
                        }}
                        colorMode="light"
                        showFileOpen={false}
                        showHelpMenu={false}
                        onChange={() => {
                            if (!readOnlyRef.current) {
                                handler.emit("change");
                            }
                        }}
                        onSave={buffer => { if (renderedSequence === loadSequence.current) void emitSave(buffer); }}
                    />
                    <footer className="word-sponsor-footer">
                        <SponsorBar placement="right" />
                    </footer>
                </>
            )}
        </div>
    );
}
