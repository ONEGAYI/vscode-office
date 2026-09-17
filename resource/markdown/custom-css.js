'use strict';

/**
 * 自定义 CSS 叠加层（custom CSS overlay）
 *
 * host 侧把 `~/.vscode-office-css/*.css` 按文件名字母序拼成一个
 * cssText，经两条路径下发：open 载荷（首次）与 `customCss` 广播
 * （目录变更热更新）。本模块把它挂成 head 末尾的单个 <style>，
 * 位于两个内置 <link> 之后，天然获得级联优先。
 *
 * 幂等：重复调用只替换内容不叠加元素；cssText 为空时移除元素。
 */
(function () {
  const STYLE_ID = 'office-custom-css';

  function applyCustomCss(cssText) {
    const existing = document.getElementById(STYLE_ID);
    if (!cssText) {
      existing?.remove();
      return;
    }
    const style = existing || document.createElement('style');
    if (!existing) {
      style.id = STYLE_ID;
    }
    // 无条件 append：已挂载时是移动操作，每次应用都把叠加层顶回
    // head 末尾，压过 vditor 运行时注入的样式
    document.head.appendChild(style);
    // textContent 不经过 HTML 解析器：内容里的 </style> 等片段无法逃逸
    style.textContent = cssText;
  }

  window.CustomCss = { applyCustomCss };
})();
