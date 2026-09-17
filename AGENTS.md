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
- dev 模式（F5）可运行的工作树需三件套：根 `node_modules`、`resource/markdown/dist`（vditor 子包构建）、`out/extension.js`（根 `npm run build`；`out/` 不进 git，新工作树默认没有）。交付新工作树供用户实测时三件齐备，否则注明缺什么

## 版本发布（fork Release）

发布到本 fork 的 GitHub Release 并附带 vsix 安装包，不发布市场。

- **版本线**：`<minor>.0-fork.N`，基于上游 minor 起跳（首发 `4.3.0-fork.1`，基于上游 4.2.0 + fork 新功能）；同 minor 内只修 bug 递增 N，同步上游新 minor 时 minor 跟进。tag 用 `v` 前缀（`v4.3.0-fork.1`），打在 fork-main 发布提交上
- **package.json 发布标识**：`publisher`=`ONEGAYI`、`displayName` 带 `(Fork)` 后缀、`bugs`/`homepage`/`repository` 指向本 fork；`viewType: cweijan.*` 与依赖 `@cweijan/exceljs` 是运行时标识，**不可改**。改 publisher 后扩展 ID 为 `ONEGAYI.vscode-office`，可与市场版并存、不被市场更新覆盖
- **打包流程**：`cd vditor && npm run build`（产物复制到 `resource/markdown/dist`，被 .gitignore 忽略但必须进 vsix）→ `npm run test:unit` + `npm run test:webview` → `npm run package`（`vsce package --no-dependencies`，经 `vscode:prepublish` 自动重跑主仓 build）→ 产出 `vscode-office-<version>.vsix`。打包后抽查 vsix 内 `resource/markdown/dist/` 时间戳为本次构建
- **创建 Release**：changelog 段写入临时文件，`gh release create v<version> --notes-file <file> vscode-office-<version>.vsix`（目标 origin）。本机 gh（Go TLS）对 api.github.com 间歇握手失败且 `HTTPS_PROXY` 救不了时，兜底 `curl` + `gh auth token` 直调 REST API：`POST /repos/ONEGAYI/vscode-office/releases`（JSON payload）→ `POST uploads.github.com/.../releases/<id>/assets?name=<file>`（`--data-binary @file`，`Content-Type: application/octet-stream`），curl/schannel 通道实测可用；命令超时后先查远端是否已建成功再决定重试
- **changelog.md**：fork 版本段插在文件顶部（`# Change log` 总标题之后、上游最新段之前），中文、沿用上游"模块分组"式；底部 `<!-- 变更链接 -->` 段维护 fork 版本链接（首发用 `/commits/v<tag>`，后续用 `/compare/v旧...v新`）

## 架构关键事实（避免重复踩坑）

- **用户可见功能的入口惯例是编辑器内优先**：Settings 面板按钮是首要入口（先例 `editViewerSettings` 四段链路：`settingsPanel.ts` footer 按钮 → `toolbar/Settings.ts` 按 `data-*` 分发 → `index.js` emit → provider handler），VSCode 命令面板为补充，`package.json` 配置项只作机制参数不作功能入口——新功能必须显式决策入口并落地，"契约没写入口"不是放行理由（custom CSS 曾整体遗漏入口，验收时才发现）
- `vditor/` 是深度定制的 fork（vscode-vditor 4.0.0，源自 vscode-ext-studio/vditor）：wysiwyg/ir 双模式、CodeMirror 6 代码块、AI 流式等。与 stock vditor 差异极大，**任何移植结论必须以本 fork 源码为准**（例：stock 的 `codeRender` 内联 max-height 在本 fork 预览路径被 CM 化掩盖）
- 代码块 CodeMirror 挂载入口是 `renderCodeBlocks`（懒挂载，视口 ±200px 内挂载、屏外 placeholder）；任何全文 DOM 替换路径（`setValue`/`applyAIResult`）之后必须补调，否则代码块退化为纯文本（IR 分支曾遗漏，上游 PR #612 修复）
- markdown webview 渲染不可信文档内容，**所有 webview → host 消息按攻击者输入处理**：校验模式见 `src/service/markdown/webviewInputValidation.ts`（上游 PR #610）
- 外部磁盘变更兜底：`checkExternalDiskChange` + `onWillSaveTextDocument` 停靠模式（上游 PR #611）；watcher 覆盖与双面板限制已在 fork 内修复（1fbe850，fork issues #4/#5 已关闭；上游侧待 #611 合并后发 PR）
- 大纲面板（vditor 内置 Outline）拖拽重排与标式透传（feat/outline-drag-reorder）：区域划分/插入判定在 `vditor/src/ts/outline/sectionIndex.ts`（纯函数，单测契约）；拖拽提交配方照抄 blockHandle 块拖拽（DOM 移动 → `renderTocNow` → `undo.addToUndoStack` → `execAfterRender({enableAddUndoStack:false})`），移动后需把光标定位到被拖标题，否则 undo 快照无 `<wbr>` 且无选区时 `renderDiff` 会崩；条目内容统一用剥离 marker 的标题克隆 innerHTML（修复 ir 路径 Lute ToC 丢弃 `<s>`），元素级样式走 `styleSnapshot.ts` 偏差式注入（与编辑器根计算值对比，font-size/font-weight 恒不透传——_reset.less 给 h1-h6 的 600 曾使全部条目呈半粗体，行内真实加粗靠 strong/b 标签直通 + UA 默认样式呈现，不依赖快照透传）；大纲行 id → 标题解析必须限于当前编辑器子级，**不能用 `document.getElementById`**（同页多编辑器/重复 id 时会命中他处导致拖拽静默失效，真实浏览器探针实测教训）；拖拽状态持标题**元素引用**而非 id——outlineRender 每次渲染按位置重编号 id，持 id 会在拖拽中途重建（输入防抖/AI 流式）时漂移到别的同基名标题而移动错误章节；dragover/drop 以自定义 MIME `application/x-vditor-outline` 识别本面板拖拽（外来拖放/残留状态不触发重排，对齐 blockHandle 的 DROP_EDITOR 先例）；`escapeOutlineCodeHTML` 的 code 内 & 预转义**只服务于喂 Lute 的 outerHTML**，直通 innerHTML 自带一次实体解析，叠加即双重转义

## 进行中工作索引

- 上游待合并 PR：#610（webview 输入校验）/ #611（外部变更兜底）/ #612（IR 模式 CM 重挂载 + codeRender 清理）/ #613（列表 marker 上游移植，基于 upstream/main）
- fork issues #1–#5：已全部修复关闭，随 v4.3.0-fork.1 交付——#1 marker 聚焦可编辑（e166a00，上游走 #613）；#2 滚动条（a117f6b 移除 400px 封顶 + #612 清理）；#3 CM 重挂载（8638b2f）；#4/#5 watcher 覆盖与双面板提示协调（1fbe850，`fix/markdown-external-sync-coverage` 已并入 fork-main；上游侧待 #611 合并后发 PR）
- 大纲拖拽重排 + 标式透传：`feat/outline-drag-reorder` 已并入 fork-main（经 review-loops 审查修复 id 漂移/外来拖放门/双重转义/on* 兜底，60 单测 + 137 webview 全绿，工作树已清理）；条目字重透传修复（标题层级 600 致整条半粗 → font-weight 恒不透传，行内加粗靠标签直通）经 PR #9 并入，工作树与分支已清理
- 用户实测结论：键盘穿透问题在本 fork 无需修复（勿重复移植）
