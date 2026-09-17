# AGENTS.md — ONEGAYI/vscode-office fork 工作约定

本仓库是 [cweijan/vscode-office](https://github.com/cweijan/vscode-office) 的 fork。`fork-main` 是本 fork 的主线分支（默认分支），承载 fork 专属约定与文档；功能开发一律走 feature 分支并向上游或本 fork 提 PR。

## 远程与分支模型

- `origin` = ONEGAYI/vscode-office（本 fork）；`upstream` = cweijan/vscode-office
- `fork-main`：fork 主线。同步上游时先快进本地 `main`（跟踪 upstream/main），再合并进 `fork-main`
- feature 分支从 `fork-main` 切出；若变更依赖某个待合并的上游 PR，则从该 PR 分支 head 切出（保持线性，PR 合并后可无缝发起后续 PR）
- 上游 PR 的 head 分支推送到 origin；PR 合并后删除对应远端分支

## 语言与提交约定

- 发往上游（cweijan/vscode-office）的 PR 与 commit：英文，conventional commits（`feat`/`fix`/`refactor`/`docs`/`chore`/`style`/`perf`/`test`），正文说明做了什么、为什么做
- 本 fork 的 issue 与 fork 专属提交（如本文件）：中文
- 发上游 PR 前必须先跑 `review-loops` 审查循环（见全局用户约定）

## 构建与验证

- 主仓构建：`npm run build`（vite，内含 vditor 生产构建链）
- vditor 子包：`cd vditor && npm run build`，产物自动复制到 `resource/markdown/dist`；`dist/` 被 .gitignore 忽略，**构建产物不进 git**，PR 只提交源文件
- 单元测试：`npm run test:unit`（`node --test "test/unit/*.test.ts"`，需 Node ≥ 22.6；仓库 CI 为 Node 20，PR 描述中注明该限制）
- 根 `tsc --noEmit` 在 main 上即损坏（TS5070 配置错误），以 `npm run build` 作为编译门；eslint 只对改动文件执行
- webview 行为验证：`vditor/dist` 可经本地 HTTP server + 探针页在真实浏览器中驱动（注意 stock vditor 的 CDN 拼接是 `{cdn}/dist/...`，cdn 参数指向 `vditor` 目录而非 `vditor/dist`）；探针文件验证完即删

## 架构关键事实（避免重复踩坑）

- `vditor/` 是深度定制的 fork（vscode-vditor 4.0.0，源自 vscode-ext-studio/vditor）：wysiwyg/ir 双模式、CodeMirror 6 代码块、AI 流式等。与 stock vditor 差异极大，**任何移植结论必须以本 fork 源码为准**（例：stock 的 `codeRender` 内联 max-height 在本 fork 预览路径被 CM 化掩盖）
- 代码块 CodeMirror 挂载入口是 `renderCodeBlocks`（懒挂载，视口 ±200px 内挂载、屏外 placeholder）；任何全文 DOM 替换路径（`setValue`/`applyAIResult`）之后必须补调，否则代码块退化为纯文本（IR 分支曾遗漏，上游 PR #612 修复）
- markdown webview 渲染不可信文档内容，**所有 webview → host 消息按攻击者输入处理**：校验模式见 `src/service/markdown/webviewInputValidation.ts`（上游 PR #610）
- 外部磁盘变更兜底：`checkExternalDiskChange` + `onWillSaveTextDocument` 停靠模式（上游 PR #611）；已知限制（watcher 覆盖、双面板）见 fork issues #4/#5
- 大纲面板（vditor 内置 Outline）拖拽重排与标式透传（feat/outline-drag-reorder）：区域划分/插入判定在 `vditor/src/ts/outline/sectionIndex.ts`（纯函数，单测契约）；拖拽提交配方照抄 blockHandle 块拖拽（DOM 移动 → `renderTocNow` → `undo.addToUndoStack` → `execAfterRender({enableAddUndoStack:false})`），移动后需把光标定位到被拖标题，否则 undo 快照无 `<wbr>` 且无选区时 `renderDiff` 会崩；条目内容统一用剥离 marker 的标题克隆 innerHTML（修复 ir 路径 Lute ToC 丢弃 `<s>`），元素级样式走 `styleSnapshot.ts` 偏差式注入（与编辑器根计算值对比，font-size 恒不透传）；大纲行 id → 标题解析必须限于当前编辑器子级，**不能用 `document.getElementById`**（同页多编辑器/重复 id 时会命中他处导致拖拽静默失效，真实浏览器探针实测教训）

## 进行中工作索引

- 上游待合并 PR：#610（webview 输入校验）/ #611（外部变更兜底）/ #612（IR 模式 CM 重挂载 + codeRender 清理）
- fork issues：#1 列表 marker 移植（排期中，需先补 Lute 语义门测试）；#2 #3 已修（随 PR #612）；#4 watcher 覆盖 / #5 双面板协调 → 分支 `fix/markdown-external-sync-coverage`（基于 #611 head，待 #611 合并后无缝 PR）
- 大纲拖拽重排 + 标式透传：分支 `feat/outline-drag-reorder`（工作树 `vscode-office-outline`），189 项测试与真实浏览器探针已过，待用户验收后向本 fork 发 PR
- 用户实测结论：键盘穿透问题在本 fork 无需修复（勿重复移植）
