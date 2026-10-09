# 漫画格式与翻译缓存

当前采用[单来源读取架构](COMIC_SOURCE_ARCHITECTURE.md)。本地保存完整源文件与索引，图片格式逐页取图，EPUB 按章节读取并重排原文；不支持单图、多张散图或云盘图片文件。

## 格式范围

| 格式 | 页序与读取 | 当前边界 |
| --- | --- | --- |
| CBZ / ZIP | 完整路径自然排序，Store / Deflate；忽略隐藏项和非图片项 | 本地、Google Drive、OPDS；本地容器 512 MiB、1500 页、10000 项；展开最多 1024 MiB；不支持加密和分卷 |
| CBR / RAR | RAR4 / RAR5，独立 Worker 按自然路径索引 | 本地及 OPDS 明确下载的完整文件；128 MiB，展开 256 MiB、1500 页；不支持加密和分卷 |
| PDF | 原始页序与旋转，按需以 144 dpi 渲染 PNG | 本地及 OPDS 明确下载的完整文件；512 MiB、1500 页；拒绝加密文件；大幅面页面受浏览器画布能力与设备内存约束 |
| 未加密 MOBI | MOBI6 / MOBI6+KF8，按正文 recindex 引用顺序；索引不读图片，逐页读图片记录 | 本地、Google Drive、OPDS；本地容器 512 MiB、1500 页；索引/正文 16 MiB；不支持独立 KF8/AZW3、HUFF/CDIC 和 DRM |
| EPUB | EPUB 2／3 的 OPF、spine、NCX／导航文档；共享阅读器界面显示可选择的 XHTML 原文、目录与字号，按包内 CSS 重排，支持内嵌位图翻译 | 本地、OPDS 可靠 Range 或明确下载的完整原包；512 MiB、10000 项，声明展开总量 1024 MiB，单份 XML／CSS 16 MiB；不支持 DRM、字体混淆、加密、分卷与 ZIP64 |

压缩包内可包含 PNG、JPEG、WebP、GIF；带 EXIF、ICC 或动画语义的页面统一到静态 sRGB PNG 首帧，其余图片保留原字节。容器索引成功即能阅读，不等待全部解码；某页损坏不妨碍其他页。全本格式错误或受保护文件不创建空漫画。

插件原图读取、规范化与页面导出不按单图字节、像素或边长拒绝图片；容器总量、解压资源、目录读取和操作超时仍有界。ZIP 单页读取预算按声明压缩字节加 16 MiB 目录／头部开销计算，实际输出必须符合声明；Drive 每次源会话网络读取预算为声明源文件字节加 16 MiB，不设固定单次 Range 大小门槛。具体上限与协议以[格式模块](../apps/extension/src/comics/formats/README.md)为准。翻译上传限制由翻译入口按所选渠道处理；阅读可用不代表一定能上传翻译。独立 KF8 和长图切片仍未实现。

EPUB 正文不建立图片页身份，不执行图片规范化，也不提供文字翻译；包内位图按[来源架构](COMIC_SOURCE_ARCHITECTURE.md#元数据与身份)接入既有逐图翻译。格式层用有界 zip.js 读取原包，EPUB.js 解析目录和原生文字排版；只为当前章节解析并持有包内样式、图片与字体，离章释放衍生 URL。脚本、表单、音视频和远程资源不运行／加载，不能将带外链的电子书视为允许联网的网页。完整原包可离线读取，来源断开仍按来源状态拒绝继续显示。位置保存 CFI 和相对包内 href，章节内比例与全书比例分开，不受字体变化产生的屏幕页数影响。

## 当前结果与缓存

完整本地文件、显式下载原图、自动页缓存、分段、缩略图和译图分别管理。清理普通缓存不删除完整源文件、主动下载资料和阅读进度。

每页实际取得字节后记录 SHA-256；PDF 渲染及图片规范化后的实际字节参与送译身份计算。图片变更重建当前内容身份，不按旧页码复用任务；重新打包的相同图片仍可按内容摘要复用本人有效翻译结果。不同来源的漫画不会因此合并。

后端按账户、内容、模式、语言与有效配置复用已完成结果；过期或已删除的访问记录不能复活。中心原图只作为任务临时输入，终态提交后立即清理。官方常规结果在中心持久保存覆盖文件，均由中心鉴权返回。客户端首次合成后缓存完整译图，命中时可直接离线读取；原图独立保留于来源／本地缓存，仅在译图缓存缺失、需要合成时恢复。规则见[翻译接口契约](READING_TRANSLATION_CONTRACT.md)、[结果复用](RESULT_SHARING.md)与[存储规范](OBJECT_STORAGE.md)。不提供漫画译本卡片、旧原文件或版本选择。

## 依赖与可重复验证

| 组件 | 锁定版本与来源 | 许可 |
| --- | --- | --- |
| [zip.js](https://github.com/gildas-lormeau/zip.js) | `@zip.js/zip.js 2.15.0`，使用本地 native streams 构建 | BSD-3-Clause |
| [node-unrar-js](https://github.com/YuJianrong/node-unrar.js) | `2.0.2`，内含 UnRAR `6.1.7` WASM | JS 包 MIT；UnRAR 使用其独立免费解压许可，包含禁止借此重建 RAR 压缩算法的条款 |
| [PDF.js](https://github.com/mozilla/pdf.js) | `pdfjs-dist 6.3.289`，legacy 主模块与同版本 Worker | Apache-2.0；内含 core-js `3.50.0`（MIT） |
| PDF 基础字体/字符映射/图像解码器 | 同一 PDF.js 包的 `standard_fonts`、`cmaps`、`wasm` | Foxit/PDFium BSD、Liberation SIL OFL 1.1、Adobe CMap BSD、QCMS MIT、OpenJPEG BSD 等；各自许可随构建打包 |
| [EPUB.js](https://github.com/futurepress/epub.js) | `epubjs 0.3.93`，按需导入 `src/book.js`，不使用整包 polyfill 入口；XML 传递依赖固定为 `@xmldom/xmldom 0.9.12` | BSD-2-Clause；xmldom 为 MIT；实际打包的传递依赖许可随构建保留 |

这些格式组件不包含模型权重。包下载地址与 SHA-512 integrity 在 [package-lock.json](../apps/extension/package-lock.json)；WASM、Worker、字体、CMap 的逐文件 SHA-256 在 [dependency-checksums.json](../apps/extension/public/import-assets/licenses/dependency-checksums.json)，其中还记录官方 UnRAR 6.1.7 源码包摘要。[UnRAR 许可](../apps/extension/public/import-assets/licenses/unrar.txt)与其他完整许可进入扩展和 Web 包。EPUB.js 的 ZIP／网络客户端不承担实际资源读取，原包和资源访问统一经过本地格式桥；其仍被打包的 JSZip、localforage 等代码保留原许可，不因运行时未使用而省略。

RAR 的 Emscripten 动态命名和 Embind 参数转换函数由 [unrar-csp.ts](../apps/extension/unrar-csp.ts)替换为静态闭包，保留参数转换、析构顺序和原 WASM。升级时构建检查会要求重新审阅。MV3 只增加本地 WASM 所需的 `wasm-unsafe-eval`，未允许 JavaScript `unsafe-eval`。Worker、字体、WASM 均随扩展发布，无运行时 CDN 依赖。

验证命令与产物位置见[脚本说明](../scripts/README.md#来源与阅读验收)。浏览器使用原创合成页，译图由隔离测试供应商产生，验证恢复及计费行为，不代表真实模型翻译效果。

## 缓存预算

完整源文件、主动下载不参与普通缓存淘汰；自动原图页、分段、缩略图和译图使用独立预算。官方与 MTU 译图预算均计入完整结果文件，官方覆盖文件不单独持久缓存。译图预算读取 `cacheLimitMb`，`-1` 表示无限制、零表示没有新增空间，调整预算会执行该缓存的清理。默认值与生效逻辑以[偏好](../apps/extension/src/comics/application/preferences.ts)和[译图缓存](../apps/extension/src/storage/translations/index.ts)为准。

无限制只取消译图缓存总量预算，仍受设备可用空间与浏览器存储配额约束；容器大小、解压资源和浏览器解码能力继续生效。手动清理译图始终保留原图、书架及阅读位置。
