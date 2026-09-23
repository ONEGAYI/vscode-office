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
- **扩展宿主集成探针（隔离 VSCode 实例）**：`--extensionTestsPath` 必须与 `--extensionDevelopmentPath` 成对给出（ext host 校验缺一即静默退出：exit 0、无输出、不开窗）；还必须给一个工作区文件夹参数，否则不开窗、测试永不执行；隔离实例配独立 `--user-data-dir` + `--extensions-dir` 防撞上已开实例。该模式下 extensionMode 是 Test(3) 而非 Development，要驱动 IS_DEV 分支需临时放宽 `ReactApp.init` 判定并重跑 build（改完源码忘 build = 无效轮次）。首跑引导压制（写进探针 profile 的 settings.json）：`workbench.startupEditor:none`、`workbench.welcome.enabled:false`、`--sync off`，Copilot 登录模态唯一根治项是 `"chat.disableAIFeatures": true`（welcome/sync/禁扩展均无效）。信号采集：测试结果写文件，ext host 的 console.log 不回 CLI stdout；`npm run build` 会 `rmSync` 整个 `out/`，build 后探针包必须重打。红绿判据：红 = 探针内直调 provider 拿到 promise reject，"编辑器 tab 存在"不构成绿（openWith 失败核心仍保留空白 tab）；连续无效轮次先 grep 核心 bundle（`resources/app/out`）定位约束，不要继续试参数

## 版本发布（fork Release）

发布到本 fork 的 GitHub Release 并附带 vsix 安装包，不发布市场。

- **版本线**：`<semver>-suian`，自 `4.4.0-suian` 起后缀统一为 `-suian`，版本号按正常 semver 递进（新功能进 minor、修复进 patch），不再使用 fork.N 计数、不绑定上游 minor。tag 用 `v` 前缀（`v4.4.0-suian`），打在 fork-main 发布提交上。历史版本线 `4.3.0-fork.1/.2` 见 changelog
- **package.json 发布标识**：`publisher`=`ONEGAYI`、`displayName` 带 `(Fork)` 后缀、`bugs`/`homepage`/`repository` 指向本 fork；`viewType: cweijan.*` 与依赖 `@cweijan/exceljs` 是运行时标识，**不可改**。改 publisher 后扩展 ID 为 `ONEGAYI.vscode-office`，可与市场版并存、不被市场更新覆盖
- **打包流程**：`cd vditor && npm run build`（产物复制到 `resource/markdown/dist`，被 .gitignore 忽略但必须进 vsix）→ `npm run test:unit` + `npm run test:webview` → `npm run package`（`vsce package --no-dependencies`，经 `vscode:prepublish` 自动重跑主仓 build）→ 产出 `vscode-office-<version>.vsix`。打包后抽查 vsix 内 `resource/markdown/dist/` 时间戳为本次构建
- **创建 Release**：changelog 段写入临时文件，`gh release create v<version> --repo ONEGAYI/vscode-office --notes-file <file> vscode-office-<version>.vsix`。`--repo` 必须显式给出：本仓双 remote 且未 `gh repo set-default` 时，gh 优先解析 `upstream`（cweijan 仓库），漏写轻则报错、重则在上游创建 Release。本机 gh（Go TLS）对 api.github.com 间歇握手失败且 `HTTPS_PROXY` 救不了时，兜底 `curl` + `gh auth token` 直调 REST API：`POST /repos/ONEGAYI/vscode-office/releases`（JSON payload）→ `POST uploads.github.com/.../releases/<id>/assets?name=<file>`（`--data-binary @file`，`Content-Type: application/octet-stream`），curl/schannel 通道实测可用；命令超时后先查远端是否已建成功再决定重试
- **changelog.md**：fork 版本段插在文件顶部（`# Change log` 总标题之后、上游最新段之前），中文、沿用上游"模块分组"式；底部 `<!-- 变更链接 -->` 段维护 fork 版本链接（首发用 `/commits/v<tag>`，后续用 `/compare/v旧...v新`）

## 架构关键事实（避免重复踩坑）

- **用户可见功能的入口惯例是编辑器内优先**：Settings 面板按钮是首要入口（先例 `editViewerSettings` 四段链路：`settingsPanel.ts` footer 按钮 → `toolbar/Settings.ts` 按 `data-*` 分发 → `index.js` emit → provider handler），VSCode 命令面板为补充，`package.json` 配置项只作机制参数不作功能入口——新功能必须显式决策入口并落地，"契约没写入口"不是放行理由（custom CSS 曾整体遗漏入口，验收时才发现）
- `vditor/` 是深度定制的 fork（vscode-vditor 4.0.0，源自 vscode-ext-studio/vditor）：wysiwyg/ir 双模式、CodeMirror 6 代码块、AI 流式等。与 stock vditor 差异极大，**任何移植结论必须以本 fork 源码为准**（例：stock 的 `codeRender` 内联 max-height 在本 fork 预览路径被 CM 化掩盖）
- 代码块 CodeMirror 挂载入口是 `renderCodeBlocks`（懒挂载，视口 ±200px 内挂载、屏外 placeholder）；任何全文 DOM 替换路径（`setValue`/`applyAIResult`）之后必须补调，否则代码块退化为纯文本（IR 分支曾遗漏，上游 PR #612 修复）
- markdown webview 渲染不可信文档内容，**所有 webview → host 消息按攻击者输入处理**：校验模式见 `src/service/markdown/webviewInputValidation.ts`（上游 PR #610）
- 外部磁盘变更兜底：`checkExternalDiskChange` + `onWillSaveTextDocument` 停靠模式（上游 PR #611）；watcher 覆盖与双面板限制已在 fork 内修复（1fbe850，fork issues #4/#5 已关闭；上游侧待 #611 合并后发 PR）
- 大纲面板（vditor 内置 Outline）拖拽重排与标式透传（feat/outline-drag-reorder）：区域划分/插入判定在 `vditor/src/ts/outline/sectionIndex.ts`（纯函数，单测契约）；拖拽提交配方照抄 blockHandle 块拖拽（DOM 移动 → `renderTocNow` → `undo.addToUndoStack` → `execAfterRender({enableAddUndoStack:false})`），移动后需把光标定位到被拖标题，否则 undo 快照无 `<wbr>` 且无选区时 `renderDiff` 会崩；条目内容统一用剥离 marker 的标题克隆 innerHTML（修复 ir 路径 Lute ToC 丢弃 `<s>`），元素级样式走 `styleSnapshot.ts` 偏差式注入（与编辑器根计算值对比，font-size/font-weight 恒不透传——_reset.less 给 h1-h6 的 600 曾使全部条目呈半粗体，行内真实加粗靠 strong/b 标签直通 + UA 默认样式呈现，不依赖快照透传）；大纲行 id → 标题解析必须限于当前编辑器子级，**不能用 `document.getElementById`**（同页多编辑器/重复 id 时会命中他处导致拖拽静默失效，真实浏览器探针实测教训）；拖拽状态持标题**元素引用**而非 id——outlineRender 每次渲染按位置重编号 id，持 id 会在拖拽中途重建（输入防抖/AI 流式）时漂移到别的同基名标题而移动错误章节；dragover/drop 以自定义 MIME `application/x-vditor-outline` 识别本面板拖拽（外来拖放/残留状态不触发重排，对齐 blockHandle 的 DROP_EDITOR 先例）；`escapeOutlineCodeHTML` 的 code 内 & 预转义**只服务于喂 Lute 的 outerHTML**，直通 innerHTML 自带一次实体解析，叠加即双重转义
- 样式操作选区保留体系（b3cdd5f，上游 #615）：wbr 单点锚表达不了选区范围，改为 strip-ZWSP 文本偏移快照 + 内容锚校验（`vditor/src/ts/util/selection.ts` ↔ `textOffset.ts`），同步段内重建非 collapsed 选区，失败/错位退回 wbr 兜底（宁可塌缩不错选）；listToggle（含批量/取消/check 空格 +1）、quote 四分支、IR 内联样式添加与移除（marker 平移 ±长度）、wysiwyg inline-code 移除均经此管道
- list marker 聚焦编辑模块（`resource/markdown/list-marker.js`，双模式，fork PR #14）：Lute 门必须覆盖全部 DOM↔HTML 入口（SpinVditorDOM/SpinVditorIRDOM/VditorDOM2Md/VditorIRDOM2Md/两个 2HTML/两个 HTML2Vditor*——**VditorIRDOM2Md 是 ir 的 getValue 路径**，缺它 span 文本被粘进 li 内容）；ir 与 wysiwyg 的列表 DOM/属性模型完全一致（li 带 data-marker），模式差异只在守卫与 CSS scope；聚焦行 live span 会经异步 selectionchange 重建（by design，保存靠门剥离）；marker 尾部 NBSP 是正文边界，输入前须 fold live span，正文行首 Backspace 与删空 marker 都复用 vditor 列表项取消路径；取消嵌套项须将当前列表拆为前段/段落/后段并保持父项 loose，父项裸正文与取消项都包成 p，否则 Lute 会拼段；loose 列表（`data-tight=false` 或缺属性）的 CSS/live marker 必须浮动到首个 p 同行
- markdown 渲染器是 **opt-in**（feat/md-renderer-opt-in）：`cweijan.markdownViewer` 声明 `priority: "option"`（与 htmlViewer/parquetViewer 同款），.md 默认用 VSCode 内置文本编辑器打开；手动入口复用既有 `office.markdown.switch`（标题栏铅笔按钮 / 命令面板 / ctrl+alt+e，双向切换，决策逻辑在 `switchEditorPlanner.ts`）；契约测试 `test/unit/markdownMenu.test.cjs` 锁 priority，同步上游时勿被覆盖回 default；用户要恢复插件默认可配 `workbench.editorAssociations` 指向 viewType
- 用户实测：键盘穿透问题在本 fork 无需修复（勿重复移植）
- Word 嵌入对象链路（4.6.0-suian）：EMF 预览的 vendor 代码（`src/react/view/word/vendor/`，源自 UDOC 项目并附 LICENSE）是第三方代码，不当作本仓源码修改；EMF→canvas 转换跑在限时 Blob Worker（`emf.worker.ts`，经 `vite/emfWorkerPlugin.ts` 内联打包，兼顾开发宿主跨源加载与生产产物）；保存保真依赖 `preservedBody.ts` 按编辑后段落顺序重建正文并原样回填嵌入块，改 Word 保存路径时勿绕过它，否则 OLE 数据丢失

## 进行中工作索引

- 上游待合并 PR：#610（webview 输入校验）/ #611（外部变更兜底）/ #612（IR 模式 CM 重挂载 + codeRender 清理）/ #613（列表 marker 上游移植，基于 upstream/main）/ #615（工具栏样式操作后保留文本选区，基于 upstream/main，分支 `origin/fix/toolbar-selection-retention` 保留至合并）
- fork PR #13（fix #10）：列表切换幂等取消吸并前段——locateTextOffset start 偏向 + batchToggleList 零交集推进/塌缩单块重解析 item
- Element/结构块守卫（G1–G8 契约），review-loops 五轮收敛；#615 基础设施的上游跟进待定
- fork PR #14（feat #11+#12）：ir list marker 编辑——#11 探针 GO（报告见 issue 评论，推翻"data-marker 空串"旧观察）+ #12 双模式落地（Lute 门 8 方法/liftOutOfList 列表外落点/CSS scope 扩展 .vditor-ir，IL0–IL6 + IE1–IE6 契约），review-loops 收敛；追加 25f6838/606d2fa 修复用户实测空项系列问题：空 li 零子节点，浏览器会把 li 内任何 caret 规范化进唯一子节点 span 文本（键入被 input gate 吞、Backspace 逐字符删 marker）——最终方案是**空内容项不激活 live span**（hasOwnContent 判定），vditor 原生键入/删项路径保留；非空项行首点击仍迁移 caret 到 span 后。教训：jsdom 不做 caret 规范化，span 相关契约须 dev 宿主真机复核。追加 47525dd 延迟提交重构（修复"不能改序号、键入失效"）：span 内输入只吞不提交，三通道分流（Enter/Space/Tab 全管线含 undo；离开 span 走 foldLive 静默折叠——**首项限定写入 + 整表属性同步**与 Lute 编号权威对齐，非首项拒绝写入杜绝 spin 延迟重写/ul 分裂；Escape 放弃）；fold 经 options.input(getValue()) 直调上报宿主保存（否则文档不 dirty 静默丢失，绕过 fireContentInput 的代价是工具栏 save 按钮不亮——记档）；stripMarkerSpans 保留 span 内 wbr（compositionend 直调 spin 路径丢光标）；mousedown 坐标 + caretPositionFromPoint 首点精确落位。语义变化：点别处从丢弃改为提交。**issue #15 已修复**：跨行首次点击 CSS marker 时，Chromium 可能把 caret 规范化到正文文本开头，并非只有 (li,0)；现在按本次点击所属 li 恢复精确命中，正文点击、Shift 选区与已有 live span 保持原行为。块拖拽按钮按 marker 的负外边距避让，避免较长序号首字符被 SVG 手柄遮挡。新增 test/browser/list-marker.test.js（npm run test:browser，可用 BROWSER_PATH 指定 Chromium）覆盖 ir/wysiwyg 首次与二次逐字符点击、旧版命中 API、拖选及 Home/Shift+Home；VSCode 1.86.2 两模式已做实际 webview 验证。已知观察项：新版 Chromium（最新 VSCode dev 宿主）下跨行点击 marker 偶发 live span 显示层消失（数据无损、切行恢复，用户 1.86.2 环境无此现象）
