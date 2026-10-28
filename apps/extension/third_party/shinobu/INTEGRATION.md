# Shinobu 源码集成

源码来自 DonutShinobu/ShinobuTranslator，固定提交与逐文件原始/修改后 SHA-256 见 `provenance.json`。仅纳入 image-pipeline、model-runtime 及其 TypeScript 依赖闭包；未纳入应用 UI、网站逻辑、模型权重或字体文件。上游 LICENSE 与 THIRD_PARTY_NOTICES 原样保留。

在仓库根目录重建：

```sh
node apps/extension/scripts/vendor-shinobu.mjs ../ShinobuTranslator
```

要求对应提交的干净 checkout；构建插件本身不依赖此 checkout。脚本完成相对导入转换、移除可能输出私有文本的 console 调用、关闭正文阶段外层重试、检测失败禁止启发式降级、使用 Blob 图片地址、支持同一所选字体/真实字重测量与绘制、排版前跳过缺字且空译文不回填原文，并补齐当前 TypeScript 所需的 override。正文翻译由宿主注入，只保留上游正文契约与供应商类型检查，不纳入另一套 HTTP 客户端；重建时移除不再被依赖的已生成源码。算法的其余改动必须通过该脚本复现，禁止只修改快照。

运行依赖实际为 ONNX Runtime Web 1.27.0 和 Comlink 4.4.2，固定在 package.json/package-lock.json；`runtime-provenance.json` 与随附许可补充上游旧版第三方清单，ORT 并非清单中旧的 1.24.1。构建将 Worker、JS/MJS/WASM 和许可写入扩展；运行时禁止下载执行代码。

模型描述、上游原有许可与发布材料记录保留在 `packages/model-manifest/`。这些记录不作为插件安装或运行门禁；普通构建支持手动下载全部模型，不需要开发开关。

完整字体沿用 NodeLane 的字体目录与 `services/compute-node/assets.json`。其来源、版本、摘要和大小在 `src/translation/font-resources.json`，许可在已随插件发布的 `public/fonts/translation/`。`scripts/prepare_local_translation_fonts.py`（fonttools 4.59.1）从已校验完整字体生成该描述及 Unicode 覆盖表，不把完整字体复制进插件。
