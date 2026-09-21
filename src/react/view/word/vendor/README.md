# UDOC EMF 阅读依赖

来源：https://github.com/NineBitsLLC/UDOC.js （2026-09-21 获取 master）。MIT，Copyright (c) 2018 Photopea，完整许可见 LICENSE。

发布包排除 src，因此同一许可证另存于 resource/licenses/UDOC-LICENSE.txt，随 VSIX 分发。

保留 UDOC.js、FromEMF.js、ToContext2D.js；这不是完整 Visio 解析器。

本地适配：添加 ES module 导入/导出和许可头；ToContext2D 的虚线取整改用 Math.round，移除对未引入的 ToPDF._flt 的依赖。EMF 坐标方向和 Worker Canvas 适配在 ../emf.worker.ts，输入限制在 ../emfValidation.ts。

仅替换页面绘制层中的预览，不修改 DOCX 数据。未支持的绘图指令可能被跳过，不能承诺完整保真。解析在限时 Worker 内执行；本轮不支持嵌入位图记录 STRETCHDIBITS、多层 RESTOREDC。
