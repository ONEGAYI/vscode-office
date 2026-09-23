# 安全与性能审查报告

审查日期：2026-09-23。基线为 `fork-main` 的 `bdb1cd5649203098389504ae5eeb0c2c265d361b`；开始审查时 `git status --porcelain=v1` 为空。审查对象包括当前源码、已有构建产物及本地 `vscode-office-4.6.0-suian.vsix`。本报告只记录问题与建议，未修改可执行源码或锁文件。

**后续状态**：本报告保留审查当时的基线证据；同日的修复与回归结果见文末“修复记录”。

## 结论

优先处理 Markdown 导出时执行原始 HTML 脚本、EPUB 元数据和表格剪贴板 HTML 的脚本注入路径，以及随 VSIX 交付的图像解析器拒绝服务问题。编辑器在反复替换含代码块的文档时持续占用内存；单个大列表的编辑也出现可感知卡顿。

| 编号 | 级别 | 结论 | 证据级别 |
| --- | --- | --- | --- |
| S1 | 高 | Markdown 导出 PDF、或导出含动态图表的 DOCX 时，不可信 HTML 可在带本地文件访问能力的 Chromium 中运行 | 源码链与隔离 Chromium 对照验证；未做完整 VS Code UI 端到端 |
| S2 | 高 | EPUB `description` 元数据未经净化进入 `dangerouslySetInnerHTML` | 源码链与 XML 解码验证；未做完整 EPUB UI 端到端 |
| S3 | 高 | 表格粘贴 HTML 会创建可执行事件属性的 DOM | 实际 `parseHtmlClipboard` 函数在 Chrome 中复现 |
| S4 | 高 | VSIX 内嵌的旧 `image-size` ICNS 解析器可因畸形图片耗尽内存 | 实际交付 bundle 的隔离进程复现 |
| S5 | 高 | `xlsx@0.18.5` 的已知漏洞可达 `.xls/.ods` 读取路径 | 公告、锁定版本与调用链确认；未复现具体漏洞输入 |
| P1 | 中 | 含代码块的文档反复 `setValue` 后 JS 堆持续增长 | Chrome 强制 GC、弱引用与普通段落对照 |
| P2 | 中 | 约 2,000 项的单个列表中输入会同步阻塞约 300–350 ms | Chrome 三档规模与普通段落对照 |
| P3 | 中 | HTTP 客户端完整缓存并解码响应；64 MiB 响应额外占用约 128.5 MiB RSS | 直接调用当前源码编译出的 `readResponseBody` 测量 |
| D1 | 中 | 首次启动迁移会递归删除 VS Code 产品级 `WebStorage` 目录 | 条件与删除目标由源码确认；未执行删除 |

证据级别说明：完整复现仅证明本次输入和环境；源码链验证证明数据能到达危险操作，但不等同于已在所有 VS Code 宿主和操作系统上复现。依赖公告命中不等同于本项目的具体利用已复现。

## 第一轮：入口、信任边界与热点

| 入口与不可信数据 | 数据流和边界 | 重点检查结果 |
| --- | --- | --- |
| Markdown 文档与 webview 消息 | `resource/markdown` → `Handler.bind` → `markdownEditorProvider` → `MarkdownService` → Chromium 导出 | S1；消息在 `src/common/handler.ts:67-69` 统一分发，具体能力须逐事件校验 |
| HTML/EPUB/Office/图像文档 | `OfficeViewerProvider` → React webview → 各格式解析器 | S2；`src/provider/officeViewerProvider.ts:37-38` 启用脚本并授予当前文件夹本地资源访问 |
| Office webview → 宿主 | `Handler.bind` → `handleCommonEvent` 的保存、外链与编辑器命令 | `openExternal` 缺少 Markdown 处理器已有的 scheme 白名单；具体宿主影响见第三轮 |
| 剪贴板 HTML | 表格粘贴事件 → `pasteFromHtml` → DOM 解析 | S3 |
| DOCX 导出图片 | Markdown/HTML → `vscode-html-to-docx` → 内嵌图片尺寸解析器 | S4 |
| `.xls/.ods` 文件 | webview `loadSheets` → `XLSX.read` | S5；`.xlsx/.xlsm` 走另一条 ExcelJS 路径 |
| 压缩包条目与目标路径 | zip/rar/tar/7z → `resolveContainedPath` → 写盘 | 有词法路径包含校验；未做各格式畸形文件模糊测试及既存符号链接场景 |
| HTTP 请求和响应 | `.http` 文件/用户操作 → `fetch` → 响应缓存 → 文本视图 | P3；请求可以主动读取文件或环境变量，属于 REST Client 功能，未证实无交互自动外传 |
| 编辑器高频路径 | `setValue`、局部输入、列表重排、代码块挂载、大纲、`getValue` | P1、P2；`getValue` 与大纲存在规模成本，但本次不单列缺陷 |
| 启动与交付物 | `onStartupFinished` → `extension.ts` 激活；VSIX 包含宿主 bundle、webview chunks 和资源 | 检查已有包与尺寸；未测 VS Code 宿主实际激活耗时 |

## 第二轮：问题与复现证据

### S1：导出 Markdown 时执行文档脚本

**触发与影响**：用户将含原始 HTML 的不可信 Markdown 导出为 PDF；含动态内容的 DOCX 导出也进入同样的浏览器预渲染路径。脚本在本机 Chromium 的 `file://` 页面运行；PDF 路径明确加了 `--allow-file-access-from-files`，本地文件可被该页面读取，并可能通过网络请求泄露。

**源码链**：`src/provider/markdownEditorProvider.ts:613-616` 调用 `MarkdownService.exportMarkdown`；`src/service/markdown/markdown-pdf.js:78` 设置 `markdownIt({ html: true })`；`src/service/markdown/html-export.js:39-68` 将 HTML 写入临时文件，以开启本地文件访问的 Chromium 打开。DOCX 动态内容路径也在 `src/service/markdown/html-export.js:117-135` 使用相同启动参数。

**验证与复现**：本地 `markdown-it` 和 `node-html-parser` 对照确认原始 `<script>` 被原样保留。隔离 Chrome 对照实验使用自造的本地文本文件：普通 `file://` 页面读取失败，加入仓库使用的启动参数后可读到仅用于测试的标记内容；测试文件已清理。现有 `out/extension.js` 含该 Chromium 参数。完整 VS Code 导出 UI 未执行，因此最终影响范围仍需在修复回归时端到端确认。

**建议**：把导出输入视为不可信；净化或禁用原始脚本及事件属性。需要图表渲染时只执行打包且受控的脚本，限制页面网络和本地文件权限，并用隔离浏览器回归测试验证。

### S2：EPUB 说明字段进入原始 HTML

**触发与影响**：打开外来 EPUB 后进入“信息”页。`description` 可形成真实 DOM；当其中有可执行 HTML 属性时，代码会在 Office webview 的脚本上下文运行。

**源码链**：`src/react/view/epub/Epub.tsx:286-300` 把 `book.loaded.metadata.description` 原样放入状态，`src/react/view/epub/Epub.tsx:591` 直接传给 `dangerouslySetInnerHTML`。当前 `epubjs` 的 `node_modules/epubjs/src/packaging.js:86,287-296` 从 OPF XML 读取该字段的节点值。`src/provider/officeViewerProvider.ts:37-38` 开启脚本，交付的 `out/webview/index.html` 无 CSP 元标签。

**验证与复现**：用无害的转义 HTML 字段测试 XML 解析，节点值还原为 `<b>AUDIT</b>`，说明 EPUB 元数据中的标记文本可到达原始 HTML 汇点。可用仅设置页面标记的合成 EPUB，在信息页检查 DOM 与脚本事件。尚未在完整 EPUB UI 中完成此步骤，故不推断能进一步获得扩展宿主权限。

**建议**：说明字段按纯文本渲染；若确需格式化，只允许明确列出的安全标签与属性。为 webview 加 CSP，禁止内联脚本和事件处理器。

### S3：表格 HTML 粘贴执行事件属性

**触发与影响**：用户在可编辑表格中粘贴带 `text/html` 的内容；表格解析时临时 DOM 可执行源 HTML 中的事件属性，脚本运行于 Office webview。

**源码链**：`src/react/view/excel/x-spreadsheet/component/sheet.js:624-649` 从剪贴板取 HTML；`core/data_proxy.js:744-746` 传给解析器；`core/clipboard_html.js:226-233` 直接写 `innerHTML` 并挂到 `document.body`，然后才抽取表格数据。移除临时节点不能取消已经触发的事件。

**验证与复现**：把当前 `clipboard_html.js` 原函数打包到隔离 Chrome，输入一张含无害错误事件标记的 HTML 表格。函数返回一行数据；200 ms 后页面标记为 `1`，即使临时图片已从 DOM 移除。只用了本地合成内容，未测试其他应用的剪贴板来源。

**建议**：使用不接入活动文档的惰性解析方式，并在提取数据前去除事件属性、可执行 URL 与不需要的元素。给交付的 webview 设置限制内联脚本的 CSP。

### S4：交付的 DOCX 图片尺寸解析器可被畸形 ICNS 阻塞

**触发与影响**：Markdown 导出 DOCX 时，`vscode-html-to-docx` 解析嵌入图片。畸形 ICNS 图片可使解析循环无法推进，导致扩展宿主进程耗尽内存或卡住。

**源码与交付物**：`src/service/markdown/html-export.js:13-19` 调用 `vscode-html-to-docx`。`npm ls image-size xlsx --all --json` 显示其依赖 `image-size@1.2.1`；现有 VSIX 的 `extension/out/node_modules/vscode-html-to-docx.js` 与本地同名构建文件 SHA-256 一致，为 `FD4CF63AB59C18214506E879B25826100E759021B6F51681BF8C486EFB5CB068`。该 bundle 中 ICNS 循环在条目长度为零时不推进偏移量。此行为与 [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) 描述一致。

**验证与复现**：在内存限制为 96 MiB 的隔离 Node 子进程中，真实交付 bundle 处理 16 字节合成畸形 ICNS 图片时约 0.45 秒以 OOM 退出；正常 1×1 PNG 对照约 90 ms 返回 DOCX。未执行实际用户文档导出。仅改变锁文件中的传递依赖版本，不能保证替换已经内嵌在交付 bundle 中的代码。

**建议**：升级或替换 DOCX 转换依赖，并核对最终 VSIX 中解析器实现；对图片类型、尺寸与处理时间增加独立进程或 Worker 级限额。

### S5：SheetJS 漏洞版本仍读取外来 `.xls/.ods`

**触发与影响**：打开外来 `.xls` 或 `.ods`，webview 将文件交给 `xlsx@0.18.5`。该版本命中 [原型污染公告](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6) 和 [正则拒绝服务公告](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9)。本次只证实版本与读取路径，未复现特定恶意工作簿，因此不把公告的一般影响直接等同于本扩展的完整利用效果。

**源码与复现**：`src/react/view/excel/excel_reader.ts:409-410,477-484` 把 `.xls/.ods` 缓冲区传给 `XLSX.read`；`src/react/view/excel/Excel.tsx:326` 由文件预览触发。`npm ls` 确认为 `xlsx@0.18.5`，构建的 Excel chunk 中也含该版本。`.xlsx/.xlsm` 使用 ExcelJS，不能把这项结论扩展到这些后缀。

**建议**：迁移 `.xls/.ods` 读取到已修复的解析器；升级后用这两种格式的正常样本做兼容回归，并对不可信文件解析加资源限额。

### P1：含代码块的整页替换造成内存持续增长

**触发与影响**：反复调用 `Vditor.setValue` 替换含代码块的文档，例如外部内容刷新。即使页面始终只有 80 个代码块，旧块与编辑器相关对象也持续保留，长会话内存上升。

**源码链**：`vditor/src/index.ts:377-395` 调用整页重绘；`vditor/src/ts/wysiwyg/renderDomByMd.ts:25` 和 IR 的 `vditor/src/index.ts:385` 替换 `innerHTML`。之后 `vditor/src/ts/codeBlock/codeMirrorManager.ts:410-418,1669-1677` 注册观察并挂载代码块。模块提供 `destroyAllCodeMirrors`（同文件 `:1354-1362`），但整页替换前未调用。观察器没有对应的 `unobserve`；反例实验表明它不是唯一原因，旧 CodeMirror 生命周期更值得优先检查。

**测量与复现**：Windows 11、Chrome 153.0.8010.53，当前 `vditor/dist/index.min.js`；80 个 fenced JS 代码块，两个模式各重复 `setValue(相同文本, true)` 30 次，每 10 次强制 GC。WYSIWYG 堆 `10,781,344→20,147,344 B`，IR `10,832,972→19,989,548 B`；当前 DOM 始终 80 块、9 个已挂载 CodeMirror，初始块的弱引用在最后一次 GC 后仍存活且已脱离 DOM。80 个普通段落对照仅 `9,362,868→9,770,624 B`。屏蔽 `observe` 后增长仍在；再令代码块不挂载 CodeMirror 时变为 `9,139,048→9,514,444 B` 并趋稳。测试探针已删除。精确保留链仍需在修复后用 heap snapshot 确认。

**建议**：整页替换和销毁编辑器前明确销毁旧 CodeMirror、取消观察与计时器；用上述真实 Chrome 强制 GC 场景作为回归。

### P2：大列表的单次输入同步卡顿

**触发与影响**：一个顶级列表包含大量条目时，在其中一项输入文字可同步重绘整张列表。约 107 KB、2,000 项的列表出现 300 ms 以上单次输入延迟。

**源码链**：WYSIWYG 的 `vditor/src/ts/wysiwyg/index.ts:360-369` 对 Markdown 触发字符跳过纯文本快路径，`wysiwyg/input.ts:113-138,218-240` 将作用域提升到顶级列表并执行 DOM→Spin→整列表替换。IR 的 `ir/input.ts:120-147,178-191` 对普通字符也有同级成本。

**测量与复现**：同一 Chrome 153 环境，用 `Array.from({length:N}, (_,i)=>'- item '+i+': '+'text '.repeat(8)).join('\n')` 构造单列表，在首项末尾连续输入三次。N=100/500/2,000 时，WYSIWYG 首次约 `31/89/342 ms`、后两次约 `13–15/59–63/311–322 ms`；IR 首次约 `30/86/356 ms`、后两次约 `14–17/58–63/342–344 ms`。2,000 个普通段落对照为 WYSIWYG `7–16 ms`、IR `6–15 ms`，并确认输入实际写入 `getValue`。

**建议**：对不改变结构的输入缩小重绘范围或使用安全的局部快路径；保留列表跨项语义测试，并加入大列表浏览器基准。

### P3：HTTP 响应完整缓存造成内存放大

**触发与影响**：REST Client 收到较大的响应；没有大小上限时，流分块、拼接缓冲区和解码字符串会同时占用内存。`HttpResponse` 还同时保存字符串与 `bodyBuffer`，可能导致扩展宿主内存峰值过高。

**源码链**：`src/provider/http/utils/httpClient.ts:96-129` 累积所有 chunks 并 `Buffer.concat`；同文件 `:57-79` 解码并保存两份表示，`src/provider/http/views/responseView.ts:17-34,98-105` 将响应保留给预览。

**测量与复现**：Windows、Node v24.15.0，直接将当前 `HttpClient` 源码在内存中编译后调用 `readResponseBody`，输入 64 MiB 的分块 `ReadableStream`，随后按 `send` 路径解码为 UTF-8。耗时 `27.8 ms`；RSS 从 `98.6` 到 `227.1 MiB`，增加 `128.5 MiB`。这是该方法的隔离测量，不代表含网络、编辑器渲染的完整延迟。

**建议**：设置明确的响应大小阈值并在流式读取时中止超限响应；二进制结果避免无条件解码，文本预览尽量按需或限长。

### D1：迁移清理范围是整个 VS Code WebStorage

**触发与影响**：首次激活时，若全局迁移标记未设置且产品级 `WebStorage` 目录存在，扩展递归删除该目录。删除目标不是本扩展的独立存储目录，可能影响同一 VS Code 产品中的其他 webview 数据。

**源码链与验证**：`src/extension.ts:29` 调用 `autoClearCacheStorage`；`src/service/autoClearCacheStorage.ts:17-46,49-68` 解析 `%APPDATA%\Code\WebStorage` 等产品目录并执行 `rm(..., {recursive:true,force:true})`。审查机该目录存在 5 个顶层条目。未读取其中数据，也未触发删除；是否已设置迁移标记未知。安全复现应使用隔离 VS Code profile，预置测试存储并保持迁移标记为空，再启动扩展。

**建议**：停止删除共享目录；若仍需迁移，只针对可证明归本扩展所有的条目，并为一次性清理提供可核查的范围与恢复方案。

## 第三轮：反例、依赖与未证实事项

- **内存归因已修正**：最初观察到代码块 `IntersectionObserver.observe` 次数由 80 增至 2,480 且未调用 `unobserve`；屏蔽观察本身后堆仍增长，故 P1 不归咎于单一观察器。禁用 CodeMirror 挂载后的稳定对照支持生命周期缺口，但尚未得到保留路径快照。
- **规模成本不等于缺陷**：约 589 KB 的 5,000 段落文档，预热后 `getValue` 为 WYSIWYG `39–59 ms`、IR `49–66 ms`；约 1,500 标题的大纲重绘为 `63–72 ms`。源码已有停笔防抖与代码块最多 15 个挂载限制，未把这些数值说成每次按键都发生。
- **依赖扫描**：`npm audit --omit=dev --registry=https://registry.npmjs.org` 报 8 个生产依赖风险（高 4、中 4）。高风险链为 `xlsx`、`image-size`/`vscode-html-to-docx`、`@xmldom/xmldom`；中风险为 `epubjs`（由 xmldom 传递）、`@mind-elixir/import-xmind`/`fast-xml-parser`、`file-type`。S4/S5 已核对实际可达路径；其余公告多涉及序列化或特定格式，本次没有证明对应漏洞输入可达，不能直接列为本项目已复现问题。默认镜像 `registry.npmmirror.com` 不提供 npm audit API，本次使用官方 npm registry 成功复查。
- **路径与命令观察**：压缩包写盘普遍调用 `src/service/compress/archiveUtils.ts:4-20` 的词法包含校验；未验证目标目录里预先存在符号链接的情形。`src/provider/compress/decompressHandler.ts:12-16` 在 macOS 把文件路径拼进 shell 命令，文件名包含 shell 特殊字符时存在命令解释风险；本机只有 Windows，未在 macOS 实测，列为待验证风险。`src/gitHistory/service/findGit.ts:19` 也拼接配置的 Git 路径，但尚未证明不可信工作区能控制该设置。
- **Webview 权限放大**：`src/provider/markdownEditorProvider.ts:185-193` 给 Markdown webview 加入 `vscode.Uri.file('/')`；交付的 Markdown 和 React HTML 都未设置 CSP。尚未证明 Markdown 编辑器存在可突破 Lute 净化的脚本入口，所以单独列为纵深防御缺口；S2/S3 的真实 HTML 汇点应优先修复。VS Code [Webview 安全指南](https://code.visualstudio.com/api/extension-guides/webview#security) 建议收窄 `localResourceRoots`、净化输入并设置 CSP。
- **宿主消息待验证**：`src/provider/compress/commonHandler.ts:110-112` 的 `openExternal` 直接解析 webview 传入的 URL，未使用 Markdown 处理器的 `http/https/mailto` 白名单；同文件 `:59-68` 的 `save` 可写当前文档。`src/react/util/vscode.ts:1-3` 导出 VS Code API 对象，现有 React chunk 也导出该对象。S2/S3 已证明 webview 脚本入口，但本次未在 VS Code 宿主里验证后续消息是否成功及 OS 协议处理结果，故暂不把宿主权限扩大算作已复现漏洞。修复时应逐事件验证 URL scheme、消息形状、大小与文件权限。
- **HTML 预览边界**：`src/service/htmlService.ts:22-41` 和 `src/provider/officeViewerProvider.ts:133-153` 会把所打开的 HTML 原文交给启用脚本的 webview。这符合 HTML 预览的现有行为，但外来 HTML 的执行权限、外部资源加载与 Workspace Trust 关系尚未做宿主端验证；不据此宣称可访问扩展宿主。
- **已有防护**：`src/service/markdown/webviewInputValidation.ts` 对若干 webview 消息、外链与导出 SVG 做输入约束，相关单测通过；压缩包解压有词法路径包含校验；`src/react/view/word/emfRenderer.ts:12-25` 将 EMF 预览放在 3 秒超时的 Worker 中。这些控制不能覆盖上述独立入口。

## 验证、交付物与边界

| 检查 | 结果 |
| --- | --- |
| `npm run test:unit` | 180/180 通过；Node v24.15.0 |
| `npm run test:webview` | 259/259 通过 |
| `npm ls image-size xlsx --all --json` | `image-size@1.2.1` 经 `vscode-html-to-docx@1.1.3`；`xlsx@0.18.5` 为直接依赖 |
| `npm audit --omit=dev --registry=https://registry.npmjs.org` | 高 4、中 4；有风险时 npm 退出码 1 |
| `vscode-office-4.6.0-suian.vsix` | 13,486,725 B，1,751 条目，解压约 41,289,440 B；包含宿主 bundle、React webview chunks、vditor、PDF.js 与 DOCX 依赖 bundle |
| 已有 `out/extension.js` | 5,516,328 B，含 PDF 导出所用 Chromium 参数；现有 VSIX 中该文件亦存在 |
| 临时探针 | 浏览器性能与安全合成探针已清理；未修改源码或锁文件 |

本次未运行 `npm run build`，以保持已测的忽略构建产物和现有 VSIX 基线不变；未做 VS Code 扩展宿主端到端、macOS/Linux、全格式模糊测试或网络侧外传测试。结果不构成“全仓没有其他问题”的证明。修复时应分别加入 PDF 导出、EPUB 信息页、HTML 粘贴、DOCX 图片解析、`.xls/.ods` 读取、代码块重复替换和大列表输入的回归验证。

## 修复记录（2026-09-23）

本节记录审查之后在 `codex/security-performance-fixes` 分支完成的源码变更。上文的版本号、审查测量和旧 VSIX 信息仍指修复前基线。

| 编号 | 修复与回归 |
| --- | --- |
| S1 | Markdown 导出内容经过标签、属性、URL 与样式允许列表净化；输出加入脚本 nonce 的 CSP，仅允许导出器注入的 Mermaid 脚本运行。任务列表复选框、标签与常见字体样式保留。单测和真实 Chrome PDF 导出回归通过。 |
| S2 | EPUB 说明字段改由 React 按纯文本转义；含 HTML 的元数据渲染测试通过。 |
| S3 | HTML 剪贴板先在惰性模板中解析，再仅将表格文本、跨度和允许的样式接入页面；常见 Excel class 样式经受限 CSS 规则复制。真实 Chrome 中的事件属性未执行，颜色和字体回归通过。 |
| S4 | DOCX 转换移入独立 Worker，限制旧生代堆为 256 MiB，超过 30 秒终止。畸形 ICNS 在普通依赖及构建交付依赖中均产生受控错误；正常 PNG 仍可导出。依赖内嵌解析器本身尚无修复版。 |
| S5 | `.xls/.ods` 使用官方 SheetJS `0.20.3` 包；两种格式的正常工作簿回归通过。 |
| P1 | 整页替换和销毁前卸载 CodeMirror，取消旧代码块的观察与定时器。webview 测试覆盖两种模式与切换模式；真实 Chrome 在异步任务完成后，第二组 30 次替换的堆增长约为 0.17–0.47 MiB。 |
| P2 | IR 模式也使用大文档纯文本快路径；两种模式在单词内部输入 `-`/`+` 时无需整张列表重绘。2,000 项列表中的真实 Chrome 连字符输入由修复前约 459/304 ms 降至约 2/1 ms（WYSIWYG/IR）；保存内容和列表节点仍正确。 |
| P3 | REST Client 读取时限制响应大小，默认 32 MiB，可在 `vscode-office.maxResponseSizeMB` 调整为 1–128 MiB；有长度头和未知长度的分块响应均受约束。超限会取消流并报出配置值，较大合法响应可调高限额后读取。 |
| D1 | 停用删除产品级 `WebStorage` 的旧迁移，只写入一次性标记；测试确认不会执行目录删除。 |

此外，Office webview 的外链协议限制为 `http`、`https`、`mailto`；Markdown webview 的本地资源根目录收窄到扩展、当前文档目录与工作区；Finder/Explorer 定位改为不经 shell 的参数调用。宿主粘贴图片改用 64 字节文件头识别常见图片格式，未知签名保留原扩展名，移除了 `file-type` 依赖；EPUB 的 `@xmldom/xmldom` 覆盖到 `0.9.12`。

**剩余边界**：`npm audit --omit=dev` 仍报告 4 条生产依赖风险（高 2、中 2）：`vscode-html-to-docx` 内嵌的 `image-size` 尚无修复版，`@mind-elixir/import-xmind` 仍打包旧 `fast-xml-parser`。DOCX 的 Worker 隔离是缓解措施，不能把依赖公告标为已消除。原报告所述完整 VS Code 宿主端到端、其他操作系统及全格式畸形输入仍未验证。收窄资源根目录后，工作区和文档目录之外的绝对路径图片可能无法在 Markdown webview 中直接显示；导出时文档自带的脚本将被移除。修复未写入原有 `vscode-office-4.6.0-suian.vsix`。

### 修复后验证

| 检查 | 结果 |
| --- | --- |
| `npm run build` | 通过，包含 vditor 和扩展宿主构建 |
| `npm run test:unit` | 211/211 通过 |
| `npm run test:webview` | 265/265 通过 |
| `BROWSER_PATH=C:/Program Files/Google/Chrome/Application/chrome.exe` 下串行运行 `test/browser/*.test.js` | 328/328 通过；包含新增的安全与性能回归 |
| `git diff --check` | 通过 |

浏览器全套测试需显式指定 Chrome 路径；本机默认选择的 Edge 无头模式会提前退出。Word EMF 浏览器测试仍输出既有的 React 兼容性和更新深度警告，但测试通过。本轮未执行完整 VS Code 扩展宿主端到端验证。
