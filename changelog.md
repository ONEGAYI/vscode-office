# Change log

# 4.4.1-suian 2026-9-19

本版修复 Markdown 块行号与宿主文档的偏移，以及图表弹窗连线在浅色主题下对比度不足两项问题。

Markdown 编辑器：

- 修复：块行号与 VSCode 文档源码行对齐——行号改用文档原文而非编辑器导出文本，表格等重排不再引起后续编号错位；打开、外部更新与保存后同步原文行号，等待同步期间隐藏旧编号；未编辑表格保留原格式，兼容原文标题、Tab 分隔与代码围栏写法——fork PR #24
- 修复：图表弹窗内 mermaid 连线在浅色编辑器主题下几乎不可读——半透明连线色实色化并保证与背景对比不低于 3:1，弹窗恢复与编辑器一致的实底卡片背景，深浅主题所见一致——fork PR #25

# 4.4.0-suian 2026-9-18

本版新增图表代码块弹窗预览，并落地列表标记、行内样式切换、行内标记拖放三批编辑器修复。版本线自本版起由 `fork.N` 计数切换为 `-suian` 后缀、按正常 semver 递进。

Markdown 编辑器：

- 新增：图表代码块弹窗预览——mermaid/plantuml 代码块右上角 popup 按钮放大查看；弹窗矢量缩放（改写 SVG 尺寸，开屏自适应无放大上限），SVG 导出经多轮消毒加固后落盘，工具栏复制按钮换 </> 源码开关防误触进入编辑——提交 a41054f
- 修复：工具栏新建/切换列表的标记缺失与任务列表转换选区丢失；无序列表统一 `-` 标记，未聚焦行显示实心圆、聚焦行显示原始标记；完整选中的列表项连同标记高亮，删除后不再残留空项——fork PR #20
- 修复：行内样式切换统一行为——光标在标记内部再次操作可取消包裹并保留光标；正文、嵌套格式与列表临时序号场景下添加样式不再丢失选区——fork PR #21
- 修复：IR 模式行内标记拖放后渲染不同步（如 `first**of**word` 拖动结束标记后文字不变粗），跨段移动同时更新来源与目标、一次撤销即可恢复；新版 VSCode webview 中编辑器拖放不再冒泡至宿主取消原生文本移动——fork PR #22

# 4.3.0-fork.2 2026-9-18

本版累积 fork.1 之后的编辑器增强与系列修复：新增外部 CSS 叠加层、选中文件纯文本比较两项功能；落地列表 marker 编辑、列表切换、文本选区保留、大纲字重等一批修复，并解决未编辑表格被保存静默重排弄脏 git 工作区的问题。

Markdown 编辑器：

- 修复：未编辑的表格不再被保存静默重排（分隔行横线数、单元格空格、表格邻接空行字节级保留；编辑过的表格才接受格式规范化）——fork PR #18
- 新增：选中文件可直接作为纯文本比较（不依赖文件类型），编辑器切换后对照视图保留——fork PR #17
- 修复：列表 marker 聚焦编辑的提交与折叠通道（Enter/Space/Tab 全管线提交、Escape 放弃、点别处提交；空列表项恢复原生键入与删除）——fork PR #14
- 修复：列表切换的幂等取消不再向前吸并相邻段落——fork PR #13
- 修复：跨行首次点击列表序号的光标定位——fork PR #16
- 修复：工具栏样式操作后保留文本选区（加粗、斜体、行内代码等不再丢失选区）——提交 568e1b5
- 修复：大纲条目不再呈半粗体（元素字重不透传，行内真实加粗保留）——fork PR #9
- 新增：外部 CSS 叠加层，`~/.vscode-office-css/` 目录热加载，Settings 面板与命令面板双入口——fork PR #8

# 4.3.0-fork.1 2026-9-17

首个 fork 版本，基于上游 [cweijan/vscode-office](https://github.com/cweijan/vscode-office) 4.2.0。以下为 fork 相对上游的全部增强；安装包以 vsix 形式发布于本 fork 的 GitHub Release（扩展 ID 为 `ONEGAYI.vscode-office`，可与市场版并存）。

Markdown 编辑器：

- 新增大纲面板拖拽重排章节，条目按元素级样式快照透传（fork PR #7）
- 新增段落源码行号与标题级别（Hx）徽标常驻显示，可在编辑器内 Settings 面板开关
- 新增无序列表快捷键 ⇧⌘O，多段选中批量切换列表（含嵌套子列表支持）
- 列表 marker 聚焦可直接编辑（Obsidian Live Preview 式）
- 修复 IR 模式内容更新后代码块退化为纯文本（上游 PR #612）
- 修复代码块预览路径滚动失效（上游 PR #612）
- 修复行号分隔线滚动后消失
- 修复开发服务器不可达时 webview 白屏，回退到内置构建资源

安全与可靠性：

- webview → host 消息全部按攻击者输入校验（链接、图片扩展名、命令白名单）（上游 PR #610）
- 文档未保存时外部磁盘变更提示，多面板协调与 watcher 覆盖扩展（上游 PR #611 及后续）

# 4.2.0 2026-8-16

Markdown Editor:

- Support configuring automatic focus restoration.
- Reduce redundant focus restoration when switching tabs.
- Fix Shift+Enter not working in IR mode.
- Fix Markmap and heading anchor jumps in IR mode.

PDF:

- Update PDF.js to v3.1.
- Remove the extra green indicator on the bookmark sidebar.

XMind:

- Fix inability to drag the canvas.

Git History:

- Improve reset button hover color.
- Improve toolbar button placement.

# 4.1.9 2026-8-13

Markdown Editor:

- Support rendering workspace images.
- Support pasting images to workspace paths.
- Support Markmap diagrams with interactive features.
- Support WikiLink graph.
- Fix overlapping alert text in IR mode.
- Fix input issues after leaving the math formula editor.

Excel:

- Support opening empty XLSX files.

XMind:

- Support editing XMind files.

SVG:

- Support customizing the preview overlay.
- Use HTML syntax to support inline CSS highlighting.

Git History:

- Show details for stash and uncommitted changes.

Editor:

- Change dirty indicator to asterisk.

# 4.1.8 2026-7-28

Excel:

- Add insert image support.
- Add image crop tools.
- Add pivot table read/write support.
- Add select-all-cells support.
- Add advanced replace options.
- Improve XLSX loading performance.
- Improve image selection and dragging behavior.
- Fix inaccurate image drag anchor positioning.
- Hide the theme toggle while loading.

Markdown Editor:

- Fix link and image edit popover layout issues.
- Align frontmatter property key icons.

PDF:

- Improve sidebar styling.

# 4.1.7 2026-7-24

Markdown Editor:

- Support hard line breaks (`Shift+Enter`).
- Support opening PlantUML diagrams in the browser.
- Update Mermaid toolbar color scheme.
- Update Edit in VS Code icon color.

Excel:

- Add auto-fit columns action.
- Update toolbar VS Code icons.
- Polish sheet tab interaction area (WPS-style navigation, sheet list menu, and active tab scrolling).
- Fix:
  - Tolerate unsupported formats and formulas.
  - Fix inaccurate cell positioning after scrolling.
  - Fix workbook loading failure caused by expanded data validation rules.
  - Fix merged cell region recognition for the default selected cell.
  - Fix CSV loading failure when the first row is empty.

PDF:

- Add PDF Pro tools and polish the tools dialog.

Git History:

- Improve details dialog positioning.

# 4.1.6 2026-7-20

Markdown Editor:

- Focus the find input after clicking the find button.
- Fix anchor and footnote jump failure in documents.

Excel:

- Add formula bar.
- Improve VS Code theme compatibility.
- Add an Edit in VS Code action to the CSV editor toolbar.
- Add filter changes to history and increase zoom debounce delay.
- Fix:
  - Fix inability to save edited empty CSV files.
  - Sync clipboard highlight when switching sheets.
  - Prevent image selection when selecting a range.
  - Prevent images from appearing across all sheets.

Diff:

- Skip CSV and DOCX files in diff view.

# 4.1.5 2026-7-8

Fix:

- Fix unexpected file reload on edit.
- Prevent Zip Slip path traversal in archive extraction(Reported by Mykhailo Kholiev).

Git History:

- Improve git history view UI.
- Change date format to yyyy-MM-dd.
- Support more remote URL formats.

Markdown Editor:

New:

- Add Shift+Tab support.
- Add typewriter mode support.
- Add new line button for quick row insertion.
- Support quick drag to resize images(Pro Feature).

Update:

- Improve large file editing performance.
- Add replace feature to find component.
- IR mode: support block drag-and-drop and table enhancements.
- Beautify context menu and settings modal.
- Remove automatic double quote completion.
- Remove default 400px code block height limit.

Fix:

- Fix failure to edit tags and wikilinks normally.
- Fix extra blank line left after deleting sublist
- Fix settings modal closing when deleting prompt or model.

Excel:

Update:

- Copy cells with HTML formatting.
- Support zoom adjustment via scroll wheel.
- Preserve formatting when pasting from Excel.
- Support editable image drag and resize.
- Support cell selection in config function.
- Improve user interaction and context menu appearance.
- Change page scrolling from cell-based to pixel-based.

Fix:

- Fix find component focus accuracy.
- Fix vertical alignment display error.
- Fix cell text overflow, editor overlay, and row height.
- Fix cell interaction and descending sort after sorting.

# 4.1.3-4 2026-7-3

Fix:

- Fix SVG loading failure.
- Fix PPTX loading failure.

# 4.1.2 2026-7-3

Markdown Editor:

- Improve AI review panel.
- Add quick action presets for AI Polish.
- Add output language selection for AI Polish.

Fix:

- Fix math formulas and diagrams (Mermaid, PlantUML) not rendering correctly after code block lazy-loading optimization.

# 4.1.1 2026-7-3

Markdown Editor:

- Add code search support within code blocks.
- Improve editor performance when handling multiple code blocks.

Export:

- Move PDF export margin inside the content container.
- Upgrade html-to-docx for improved DOCX export quality.
- Dynamically load export dependencies (HTML, DOCX, PDF) to reduce extension size.

Git History:

- Add warning echo for Git operations.
- Fix graph being incorrectly dimmed.
- Align author filter options and simplify filtered graph.

Update:

- Improve view rendering performance.
- Replace cheerio with node-html-parser.
- Dynamically load Mermaid and Puppeteer to reduce extension size.

Fix:

- Resolve inline HTML rendering issue.
- Resolve file loading failure on Windows virtual space.

# 4.1.0 2026-7-1

New: Add Parquet file format support.

Markdown Editor:

- Improve visual design.
- Update keyboard shortcuts.
- Support code block font configuration.
- Improve light/dark mode switching logic.
- Fix failure to open relative path files in IR mode.
- Support font size adjustment via scroll wheel in the editor.

Pro:

- Introduce Pro license activation.
- Remove Sponsor banner after Pro activation.
- Support custom font color and background color editing.
- Support adjusting image width and height in the Markdown editor.
- Support beautiful PDF / HTML / DOCX export with theme, font, and font-size options.

Git History:

- Improve visual design.
- Adjust Git branch colors for better visibility in light mode.
- Gray out non-current commits while loading Git history view.
- Fix color inconsistency between graph lines and branches in Git history view.

# 4.0.9 2026-6-29

Update:

- Restore missing HTML viewer previewer registration.
- Fix outline loading failure caused by special headings (code blocks, line breaks).
- Improve file loading performance by streaming via webview URI instead of message buffer transfer.

# 4.0.8 2026-6-29

Markdown editor:

Update:

- Add image preview.
- Beautify CodeMirror toolbar.
- Disable latex syntax validation.
- Remember last selected theme preference.
- Sync settings to other editors after modification.
- Support expandable code blocks with configurable height.

Git History:

- Improve Git view and Git history view styling.
- Support double-click to quick push in Git view.
- Git history view supports pull and batch operations.

Fix:

- Support saving links with spaces.
- Fix class file decompilation failure.
- Fix Wikilinks in remote environment.
- Preserve bold text color in light theme.
- Prevent file cache generation after each view.
- Fix relative links and images in remote environment.
- Fix markdown editor loading issue for Russian locale.
- Fix the missing margin for the first child element at the top of the page.

# 4.0.7 2026-6-26

New:

- Support editing Vditor configuration via a configuration file.
- Markdown editor supports remote and web workspaces (vscode-vfs, vscode-remote).

Update:

- Beautify alert color.
- Improve PDF loading performance.
- Improve Git history view styling.
- Improve TIFF/HEIC loading performance.
- Change the default Excel font size to 11.
- Remove Git history caching for more accurate data.

Markdown:

- Add AI polish usage tip in settings panel.
- Fix CodeMirror font not syncing with typography settings.
- Fix pasted math formula blocks being converted into code blocks.

Fix:

- Fix incorrect read-only mode detection.
- Fix remote URL order in Git view with multiple repositories.

# 4.0.6 2026-6-26

New:

- Full support for Excel.
- Support editing DOCX files.
- Support the web version of VS Code.

Markdown:

- Support Wikilinks.
- Support AI-powered polishing.
- Support configuring editor typography.
- Support previewing and editing inline HTML.
- Support highlighting and autocompletion for latex formulas.

# 4.0.5 2026-6-23

Important: **Refactor Markdown editor**: beautified UI with modernized toolbar, in-page search (Ctrl/Cmd+F), and real-time code block editing

Other:

- Update Material Icons
- Add Kusto (KQL) syntax highlighting
- Beautify Git history view: refreshed styling and a commit details panel
- Support batch Git operations: push branches, add tags, and delete tags across multiple remotes in one action

# 4.0.4 2026-6-19

New:

- Add Kotlin syntax highlighting
- Add Nginx conf syntax highlighting
- Add anonymous usage telemetry (respects VS Code global telemetry settings)

Update:

- Beautify the SVG and PDF view
- Hide sponsor banner in Excel view while loading
- Refresh Git history after deleting filtered branches

# 4.0.3 2026-6-18

Important:

- Redesign the One Dark Modern theme
- Add Git history management feature

New:

- Add SVG editor
- Add support for ODS format
- Add syntax highlighting for TOML
- Add YAML outline and anchor navigation support

Update:

- Add dark mode toggle to PDF viewer
- Update markdown editor default theme
- Add icons for Parquet, SQLite, and DuckDB
- Change the default PPTX view to light mode
- Support quick switch color in markdown editor

# 4.0.2 2026-6-15

- Integrate HTTP client for `.http` and `.rest` files
- Support XMind, PSD, ICNS, HEIC and TIFF formats

# 4.0.1 2026-6-14

- Better zip viewer
- Fix excel save tip gone

# 4.0.0 2026-6-14

- Support pptx and epub files
- Support 7zip and tar.gz archives
- Better support for docx, excel, pdf and archives

# 3.5.7 2026-6-12

- Fixed paste image failed in markdown editor

# 3.5.6 2026-6-10

- Update puppeteer-core version
- Beautify zip,font,image and markdown view
- Fix command 'office.markdown.paste' hijacks ctrl/cmd+v

# 3.5.5 2026-6-8

- Update mermaid version
- Integrate Vditor resources
- Fix Excel cell shortcut keys not working on MacOS

# 3.5.4 2025-4-28

- Support edit excel and csv file.

# 3.5.3 2025-4-17

- Support view rar file.

# 3.5.2 2025-4-10

- Compatible with rest client.

# 3.5.1 2025-4-7

- Better support for zip viewer.
- Update extension name and icon.
- Support export markdown with Mermaid.

# 3.5.0 2025-1-14

- Remove markdown editor border.

# 3.4.8 2024-12-14

- Modify the font of the markdown editor.

# 3.4.6 2024-12-13

- Add more markdown editor theme.
- Support refresh for zip viewer.

# 3.4.2 2024-9-28

- Fixed "Edit In VS Code" shortcut not working.
- Fixed copying content failure in preview mode.

# 3.3.4 2024-6-4

- Better csv and zip support.

# 3.3.3 2024-5-6

- Support edit svg in VS Code.
- Fix shortcut key conflict with Copilot.
- Support display font item name and search font item.

# 3.3.2 2024-4-6

- Support sort zip items.

# 3.3.1 2024-3-30

- Update font and pdf viewer.

# 3.3.0 2024-3-29

- Rewrite the UI front end using React.

# 3.2.5 2024-3-8

- Add shortcut document.
- Update editor switch icon.
- Fix load chinese zip entry failed.

# 3.2.4 2024-3-5

New:

- Support view woff2 font.
- Support modifying editor theme individually.

Markdown

- Follow vscode editor font size.
- Add button to quick switch markdown editor.

Other:

- Support edit in vscode for csv.
- Support edit in vscode for svg.
- Only use image viewer for svg.

# 3.2.0 2024-3-4

- Use vscode default editor when diffing.
- Fix cannot save outline state for macOS.
- Fix cannot find chromium path on macOS.

# 3.1.7 2023-9-32

- Fix export markdown to docx fail.

# 3.1.5 2023-5-18

- Support view apk file.

# 3.1.4 2023-5-4

- Support view zip file.

# 3.1.2 2023-4-25

- Change inactive tab foreground color.

# 3.1.1 2023-4-24

- Update peek view colors.
- Remove semantic highlighting.

# 3.1.0 2023-4-13

- Better theme colors.
- Markdown:
  - Katex compatible wrong formula.
  - Load the chart with a white background.
  - Support for rendering latex formulas in an offline environment.

# 3.0.4 2023-4-11

- Modify the background color of the theme.

# 3.0.2 2023-4-5

- Update extension icon.

# 3.0.1 2023-4-3

- Fix git view cannot view pictures.
- Support for reloading workspace docx after file changes.
- PDF:
  - Fixed sometimes opening PDF failed.
  - Do not display the sidebar on small screens.
  - Support export markdown to pdf without outline.

# 3.0.0 2023-3-29

- Better docx rendering.

# 2.9.6 2023-3-7

- Reduce the size of the excel save notice.
- Support resizing the view through ctrl/meta with mouse scrolling.
- Word:

  - Fix cannot display images.
  - Fix pager jumping incorrectly.
  - Reduce pagination navigator size.
- Markdown:

  - Support hide toolbar.
  - Fix extension activation failure when rest client exists.
  - Support open hyperlinks via meta or middle mouse button.

# 2.9.5 2023-1-12

- 更新主题的editorInlayHint颜色.
- Markdown:
  - 代码块预览增加行号显示.
  - 支持配置代码块颜色样式.
  - 粘贴图片路径增加workspaceDir变量.
  - 修复无法导出PDF.
  - 修复无法显示绝对路径的图片.

# 2.9.4 2022-12-20

- 调整代码块颜色.
- 支持设置导出pdf的chromium路径.

# 2.9.3 2022-12-10

- 修复Pdf部分字体无法加载.
- QuickItem和菜单的border颜色优化.

# 2.9.2 2022-12-6

- 修复表格工具栏消失.
- 保存xlsx时增加确认框.
- 导出Html和docx时不生成目录.
- 修复图片过多时无法显示图片文件名.

# 2.9.1 2022-11-23

- 调整markdown编辑器小屏下的大纲宽度
- Markdown转换的Pdf调整页面边距.

# 2.9.0 2022-11-9

- Speed up extension activation.

# 2.8.1 2022-10-29

- Fix preview html unable to load images.
- Markdown:
  - Support export to docx.
  - Fix hr can not display on dark theme.
  - Edit math formulas using different background colors.
  - Fix export pdf not rendering math formulas that start or end with spaces.

# 2.8.0 2022-10-24

- Change markdown editor default language to english.
- Supporting change of language for editor [en_US, ja_JP, ko_KR, ru_RU, zh_CN, zh_TW]

# 2.7.9 2022-10-23

- 修复小屏下工具栏丢失.

# 2.7.8 2022-10-19

- Markdown:
  - 修复导出的pdf数学公式显示异常.
  - 优化自带主题的markdown显示效果.
- Pdf:
  - 优先显示大纲视图.
  - 美化部分视觉效果.
  - 修复只能显示二级大纲.

# 2.7.7 2022-10-18

- markdown:
  - 升级katex版本.
  - 固定工具栏位置.
  - 记住文件最后的编辑位置.
  - 修复切换不同的markdown总数没有更新.
  - 修复小屏下工具栏样式异常, 以及无法显示大纲.

# 2.7.5 2022-10-12

- 优化大纲切换的焦点.

# 2.7.4 2022-10-11

- markdown
  - 修复字数没有实时更新.
  - 修复diff视图无法显示图片.
  - 修复部分情况下在外部编辑后没有实时更新.
- 修复excel无法保存更新.
- 图片浏览器支持通过ctrl+滑动放大图片.

# 2.7.3 2022-10-5

- 完善焦点聚焦逻辑.
- 支持ctrl+shift+v粘贴为纯文本.
- 增加自动清理webview缓存.
- Markdown:

  - 自动识别粘贴的图片类型.
  - 修复粘贴文本后选中的文本还在.
- 预览Html支持解析本地js文件.

# 2.7.2 2022-9-15

- 移除图片中的空格.
- 修复latex公式显示不全.

# 2.7.1 2022-9-5

- 优化编辑器焦点恢复功能.

# 2.7.0 2022-9-2

- 升级vditor版本.
- 增加设置编辑器焦点的延迟.
- 美化右键菜单样式, 点击其他地方后隐藏菜单.

# 2.6.9 2022-8-29

- 修复代码块背景颜色异常.

# 2.6.8 2022-8-28

- Markdown: 修复显示绝对路径图片的设置无效.
- Xlsx:
  - 支持查看xlsm文件.
  - 加快excel文件打开速度.
  - 修复xlsx超过26的列无法显示.

# 2.6.7 2022-8-28

- Markdown:
  - 修复分割线无法显示.
  - 移除单引号和美元符号的补全.
  - 导出的pdf目录序号修改样式为圆圈.
  - 支持关闭代码预览, 修改代码块背景颜色.
- 修复查看docx文件时, 如果页面数量页面错乱.

# 2.6.1 2022-6-19

- 修复在Vditor无法打开相对路径的markdown.

# 2.6.0 2022-6-13

- 对主题的自适应功能进行优化.
- 修复编辑markdown时输出了无关日志.

# 2.5.8 2022-6-7

- 支持打开dotx文件
- markdown编辑器支持打开图片超链接
- 更新超链接颜色

# 2.5.7 2022-6-7

- 优化粘贴图片的逻辑
- 优化自动主题颜色的边框颜色
- 保存后更新字数总数
- 修改默认代码主题

# 2.5.5 2022-5-28

- 支持配置markdown粘贴图片的路径
- 更新vditor版本

# 2.5.1 2021-12-29

- 增加稳定性, 修复图片有时保存失败
- Support save outline open state.

# 2.5.0 2021-12-27

- Update markdown editor:
  - To open a hyperlink, need to hold down ctrl.
  - Support chose image from toolbar.
  - Update editor when external update.
  - Open source code editor as beside.
- Fix puml editor not trigger save.
- Fix html preview not support untitle document.

# 2.4.2 2021-12-4

- Fix markdown editor cannot cut, loss focus.

# 2.4.1 2021-9-9

- Rollback docx support.
- Fix http auto-complection fail.
- Reduce markdown editor cache usage.

# 2.4.0 2021-8-3

- Better http client support.
- Fix markdown editor cannot save.

# 2.2.2 2021-6-19

- Speed up picture pasting

# 2.2.0 2021-6-2

- Not trigger vscode hotkey when match markdown hotkey.
- Support immediately preservation.

# 2.1.1 2021-5-27

- Change vditor mode from ir to wysiwyg.
- Fix markdown cannot type tab.
- Reduce markdown editor padding.

# 2.0.0+

- Support ods file.
- Remove top button of word document.
- Remove markdown style.
- Support inline markdown.
- Support export to html.
- Markdown support auto quote.
- Change viewer name as editor.
- Change default markdown editor as vditor.

# 1.9.1 2021-1-18

- Fix cannot view big xmind.
- Support follow theme with docx viewer.
- Image viewer support show pixel.

# 1.9.0 2020-12-30

- Support view csv file with utf8 encoding.

## 1.8.9 2020-12-21

- Update java decompiler version, change priority as option.
- Markdown editor support paster as plain text.

## 1.8.1 2020-11-24

- Change export markdown pdf chinese font to 'Song  style'
- Export markdown auto add bookmarks.
- Update markdown list style.

## 1.8.0 2020-11-24

- Support play flash swf animation.

## 1.7.10 2020-11-23

- Support open link from markdown.

## 1.7.9 2020-11-19

- support paste image file in markdown editor.

## 1.7.7 2020-11-17

- Update status bar when open markdown editor.

## 1.7.5 2020-11-11

- Add java class decompiler.

## 1.7.1 2020-11-3

- Support generate outline for pdf.

## 1.7.0 2020-11-2

- Support export markdwon to pdf.
- Support edit xlsx、xls、csv.

## 1.6.0 2020-10-19

- Add font viewer.
- Adjust markdown style and fix save fail bug.

## 1.5.0 2020-10-16

- Enhance Image viewer.

## 1.4.3 2020-10-12

- Fix paste fail in terminal.
- Using hyperMD as default markdown editor.

## 1.4.0 2020-10-9

- Integrate stackedit to edit markdown.
- Add csv support.

## 1.3.0 2020-10-8

- Add plantuml support.
- Adjust svg css.

## 1.2.0 2020-10-8

- Add pdf support.
- Add xmind support.

## 1.1.0 2020-10-8

- Add epub support.
- Add svg support.
- Add photoshow support.
- Add windows reg support.
- Add paginition to docx view..

<!-- 变更链接：fork 版本线 -->

[4.3.0-fork.1]: https://github.com/ONEGAYI/vscode-office/commits/v4.3.0-fork.1
[4.3.0-fork.2]: https://github.com/ONEGAYI/vscode-office/compare/v4.3.0-fork.1...v4.3.0-fork.2
[4.4.0-suian]: https://github.com/ONEGAYI/vscode-office/compare/v4.3.0-fork.2...v4.4.0-suian
[4.4.1-suian]: https://github.com/ONEGAYI/vscode-office/compare/v4.4.0-suian...v4.4.1-suian
