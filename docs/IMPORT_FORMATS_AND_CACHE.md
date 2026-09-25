# 漫画格式与翻译缓存

当前采用[单来源读取架构](COMIC_SOURCE_ARCHITECTURE.md)。本地保存完整源文件与索引，逐页取图；不支持单图、多张散图或云盘图片文件。

## 格式范围

| 格式 | 页序与读取 | 当前边界 |
| --- | --- | --- |
| CBZ / ZIP | 完整路径自然排序，Store / Deflate；忽略隐藏项和非图片项 | 本地和 Google Drive；512 MiB、1500 页、10000 项；展开最多 1024 MiB、单项 32 MiB；不支持加密和分卷 |
| CBR / RAR | RAR4 / RAR5，独立 Worker 按自然路径索引 | 仅本地；128 MiB，展开 256 MiB，单项 32 MiB、1500 页；不支持加密和分卷 |
| PDF | 原始页序与旋转，按需渲染 PNG | 仅本地；512 MiB、1500 页；144 dpi，限制 1600 万像素、单边 8192；拒绝加密文件 |
| 未加密 MOBI | MOBI6 / MOBI6+KF8，按正文 recindex 引用顺序；索引不读图片，逐页读图片记录 | 本地和 Google Drive；本地容器 512 MiB、1500 页；索引/正文 16 MiB、图片 32 MiB；不支持独立 KF8/AZW3、HUFF/CDIC 和 DRM |

压缩包内可包含 PNG、JPEG、WebP、GIF，GIF 阅读使用规范化 PNG 首帧。容器索引成功即能阅读，不等待全部解码；某页损坏不妨碍其他页。全本格式错误或受保护文件不创建空漫画。

具体上限与协议以[格式模块](../apps/extension/src/comics/formats/README.md)为准。阅读可用不代表超过后端翻译限制的图片一定能翻译；EPUB、独立 KF8 和长图切片仍未实现。

## 当前结果与缓存

完整本地文件、显式下载原图、自动页缓存、分段、缩略图和译图分别管理。清理普通缓存不删除完整源文件、主动下载资料和阅读进度。

每页实际取得字节后记录 SHA-256；PDF 渲染和 GIF 规范化后的字节参与身份计算。图片变更重建当前内容身份，不按旧页码复用任务；重新打包的相同图片仍可按内容摘要寻找本人有效资产并复用有效翻译结果。不同来源的漫画不会因此合并。

后端按内容、模式、语言与有效配置复用已完成结果，访问记录按用户隔离；过期或已删除的访问记录不能复活。原图和最终译图保存在私有 R2，默认无限期保留，不随普通客户端缓存清理删除。规则见[翻译接口契约](READING_TRANSLATION_CONTRACT.md)、[译图共享](RESULT_SHARING.md)与[对象存储](OBJECT_STORAGE.md)。不提供漫画译本卡片、旧原文件或版本选择。

## 依赖与可重复验证

| 组件 | 锁定版本与来源 | 许可 |
| --- | --- | --- |
| [zip.js](https://github.com/gildas-lormeau/zip.js) | `@zip.js/zip.js 2.15.0`，使用本地 native streams 构建 | BSD-3-Clause |
| [node-unrar-js](https://github.com/YuJianrong/node-unrar.js) | `2.0.2`，内含 UnRAR `6.1.7` WASM | JS 包 MIT；UnRAR 使用其独立免费解压许可，包含禁止借此重建 RAR 压缩算法的条款 |
| [PDF.js](https://github.com/mozilla/pdf.js) | `pdfjs-dist 6.3.289`，legacy 主模块与同版本 Worker | Apache-2.0；内含 core-js `3.50.0`（MIT） |
| PDF 基础字体/字符映射/图像解码器 | 同一 PDF.js 包的 `standard_fonts`、`cmaps`、`wasm` | Foxit/PDFium BSD、Liberation SIL OFL 1.1、Adobe CMap BSD、QCMS MIT、OpenJPEG BSD 等；各自许可随构建打包 |

这些格式组件不包含模型权重。包下载地址与 SHA-512 integrity 在 [package-lock.json](../apps/extension/package-lock.json)；WASM、Worker、字体、CMap 的逐文件 SHA-256 在 [dependency-checksums.json](../apps/extension/public/import-assets/licenses/dependency-checksums.json)，其中还记录官方 UnRAR 6.1.7 源码包摘要。[UnRAR 许可](../apps/extension/public/import-assets/licenses/unrar.txt)与其他完整许可进入扩展和 Web 包。

RAR 的 Emscripten 动态命名和 Embind 参数转换函数由 [unrar-csp.ts](../apps/extension/unrar-csp.ts)替换为静态闭包，保留参数转换、析构顺序和原 WASM。升级时构建检查会要求重新审阅。MV3 只增加本地 WASM 所需的 `wasm-unsafe-eval`，未允许 JavaScript `unsafe-eval`。Worker、字体、WASM 均随扩展发布，无运行时 CDN 依赖。

验证命令与产物位置见[脚本说明](../scripts/README.md#来源与阅读验收)。浏览器使用原创合成页，译图由隔离测试供应商产生，验证恢复及计费行为，不代表真实模型翻译效果。

## 缓存预算

完整源文件、主动下载不参与普通缓存淘汰；自动原图页、分段、缩略图和译图使用独立预算。译图预算读取 `cacheLimitMb`，`-1` 表示无限制、零表示没有新增空间，调整预算会执行该缓存的清理。默认值与生效逻辑以[偏好](../apps/extension/src/comics/application/preferences.ts)和[译图缓存](../apps/extension/src/storage/translations/index.ts)为准。

无限制只取消插件预算，仍受设备可用空间与浏览器存储配额约束；单文件大小、解压资源和解码限制继续生效。手动清理译图始终保留原图、书架及阅读位置。
