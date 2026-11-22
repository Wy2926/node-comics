# Shinobu 源码集成

源码来自 DonutShinobu/ShinobuTranslator，固定提交与逐文件原始/修改后 SHA-256 见 `provenance.json`。仅纳入 image-pipeline、model-runtime 及其 TypeScript 依赖闭包；未纳入应用 UI、网站逻辑、模型权重或字体文件。上游 LICENSE 与 THIRD_PARTY_NOTICES 原样保留。

在仓库根目录重建：

```sh
node apps/extension/scripts/vendor-shinobu.mjs ../ShinobuTranslator
```

要求对应提交的干净 checkout；构建插件本身不依赖此 checkout。脚本从本机适配器实际导入的阶段出发，读取固定提交的 Git 文件，重建依赖并移除已无调用的源码。快照不含上游整页调度、正文客户端或诊断 RPC；移除可能输出私有文本的 console 调用。算法改动必须通过该脚本复现。

本机适配器按页协调分带检测、OCR、去字、正文翻译与排版。OCR 透视裁切不超过模型输入宽度，同宽推理每批最多四行。测量与绘制使用同一已校验字体及字重，排版跳过缺字，空译文不回填原文。

英、西语嵌字参考 [manga-image-translator 的气泡内按词横排](https://github.com/zyddnys/manga-image-translator/blob/main/manga_translator/rendering/text_render_eng.py)。客户端实现位于适配器 `latin-typeset.ts`：复用 Shinobu 的掩膜安全区、字体与颜色，用 Worker Canvas 整行测量和绘制；共享气泡的文字块在各自原框内排版。

运行依赖实际为 ONNX Runtime Web 1.27.0 和 Comlink 4.4.2，固定在 package.json/package-lock.json；`runtime-provenance.json` 与随附许可补充上游旧版第三方清单，ORT 并非清单中旧的 1.24.1。构建将 Worker、JS/MJS/WASM 和许可写入扩展；运行时禁止下载执行代码。

模型描述、上游原有许可与发布材料记录保留在 `packages/model-manifest/`。这些记录不作为插件安装或运行门禁；普通构建支持手动下载全部模型，不需要开发开关。

字体清单为仓库根 `shared/font-assets.json`。来源、版本、摘要与大小在插件 `src/translation/font-resources.json`，许可在 `public/fonts/translation/`；根脚本 `prepare_local_translation_fonts.py` 从已校验字体生成描述和覆盖表。
