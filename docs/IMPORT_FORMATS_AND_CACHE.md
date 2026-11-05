# 漫画格式与翻译缓存

当前采用[单来源读取架构](COMIC_SOURCE_ARCHITECTURE.md)。本地保存完整源文件与索引，图片格式逐页取图，EPUB 按章节读取并重排原文；不支持单图、多张散图或云盘图片文件。

## 格式范围

| 格式 | 页序与读取 | 当前边界 |
| --- | --- | --- |
| CBZ / ZIP | 完整路径自然排序，Store / Deflate；忽略隐藏项和非图片项 | 本地、Google Drive、OPDS；本地容器 512 MiB、1500 页、10000 项；展开最多 1024 MiB；不支持加密和分卷 |
| CBR / RAR | RAR4 / RAR5，独立 Worker 按自然路径索引 | 本地及 OPDS 明确下载的完整文件；128 MiB，展开 256 MiB、1500 页；不支持加密和分卷 |
| PDF | 原始页序与旋转；阅读按显示尺寸渲染，送译固定 144 dpi，原图导出直接保存源 PDF，增强按需提取可独立使用的内嵌原图 | 本地及 OPDS 明确下载的完整文件；512 MiB、1500 页；拒绝加密文件；大幅面页面受浏览器画布能力与设备内存约束 |
| 未加密 MOBI | MOBI6 / MOBI6+KF8，按正文 recindex 引用顺序；索引不读图片，逐页读图片记录 | 本地、Google Drive、OPDS；本地容器 512 MiB、1500 页；索引/正文 16 MiB；不支持独立 KF8/AZW3、HUFF/CDIC 和 DRM |
| EPUB | EPUB 2／3 的 OPF、spine、NCX／导航文档；共享阅读器界面显示可选择的 XHTML 原文、目录与字号，按包内 CSS 重排，支持内嵌位图翻译 | 本地、OPDS 可靠 Range 或明确下载的完整原包；512 MiB、10000 项，声明展开总量 1024 MiB，单份 XML／CSS 16 MiB；不支持 DRM、字体混淆、加密、分卷与 ZIP64 |

压缩包内可包含 PNG、JPEG、WebP、GIF；带 EXIF、ICC 或动画语义的页面统一到静态 sRGB PNG 首帧，其余图片保留原字节。容器索引成功即能阅读，不等待全部解码；某页损坏不妨碍其他页。全本格式错误或受保护文件不创建空漫画。

插件原图读取、规范化与页面导出不按单图字节、像素或边长拒绝图片；容器总量、解压资源、目录读取和操作超时仍有界。ZIP 单页读取预算按声明压缩字节加 16 MiB 目录／头部开销计算，实际输出必须符合声明；Drive 每次源会话网络读取预算为声明源文件字节加 16 MiB，不设固定单次 Range 大小门槛。具体上限与协议以[格式模块](../apps/extension/src/comics/formats/README.md)为准。翻译上传限制由翻译入口按所选渠道处理；阅读可用不代表一定能上传翻译。

EPUB 正文不建立图片页身份，不执行图片规范化，也不提供文字翻译；包内位图按[来源架构](COMIC_SOURCE_ARCHITECTURE.md#元数据与身份)接入既有逐图翻译。格式层用有界 zip.js 读取原包，EPUB.js 解析目录和原生文字排版；只为当前章节解析并持有包内样式、图片与字体，离章释放衍生 URL。脚本、表单、音视频和远程资源不运行／加载，不能将带外链的电子书视为允许联网的网页。完整原包可离线读取，来源断开仍按来源状态拒绝继续显示。位置保存 CFI 和相对包内 href，章节内比例与全书比例分开，不受字体变化产生的屏幕页数影响。

章节先清理内容，再在 head 首位加入 `script-src 'none'` 等 CSP。iframe 允许宿主阅读器注册事件所需的脚本能力，以兼容 WebKit；书内脚本、事件属性和外部脚本仍由清理与 CSP 禁止。正文点按监听注册在 body，保证 iOS Safari 能为文字和图片生成点击事件。

PDF 阅读图片按实际显示宽度（含双页缩放与对照分栏）乘屏幕 DPR 请求 PNG；目标宽度向上按 128 像素归档，已有分辨率足够时复用，放大停稳 200ms 后重绘。邻页使用相同显示质量、较低调度优先级，进入当前页直接复用；双页后续组按翻页后的适屏尺寸准备。连续模式沿用当前及后三页的解码窗口；额外预读仍最多五页、只保留压缩字节、总预算 64 MiB，350ms 稳定后开始，给当前页缩放重绘优先取得来源槽。临时显示画布最多 16×1024×1024 像素、单边 16384，超出时等比降低显示分辨率，不拒绝页面或修改源文件；单份 RGBA 工作集约 64 MiB，换图时还会短暂保留旧图，不代表浏览器总内存上限。新图解码并实际加载后替换旧图，失败保留可读图片和重试入口，页码及页内位置不变。

显示图片仅随有界阅读租约保留，不写入原图缓存、页面摘要或翻译身份。布局尺寸沿用送译图片的稳定几何，避免缩放覆盖送译尺寸。送译及已有覆盖结果恢复保留固定 144 dpi 的 `pdf-v3-static-srgb`；旧任务和已有译图不会因阅读缩放改变，译图本身不会随之增加细节。

PDF 原图导出直接逐字节保存完整源 PDF，不渲染、缩放或重新编码，不附加清单或修改原文件结构；原文件的文字、矢量、内嵌图片和元数据均保留。此入口不再提供转换为 CBZ／ZIP 的原图导出选项。流式写入沿用 1 MiB 分块，缓冲下载沿用 128 MiB 上限，无需页面画布或整本图片缓存。

PDF 原页增强仅提取能独立表示整页的 JPEG 原字节：单张图片完整覆盖页面、正常方向、设备 RGB／灰度、无掩膜或额外可见内容；允许不参与显示的 OCR 文字。需要拼接、裁剪、旋转、透明合成、颜色转换或重新编码的页，以及非 JPEG 内嵌图，均正常跳过并保留阅读显示，不发增强请求、不显示失败，也不回退到固定 DPI 渲染。已有译图继续按完整结果图片增强。

原图提取复用 PDF.js Worker 的页面解析和随机读取，不加载第二个 PDF 解析器、不整本扫描、不解码图片像素或生成画布。增强仍在服务串行槽内按需读取；提取租约和阅读、送译共用两并发来源队列、取消及访问复核。提取不写入页面缓存、摘要或布局几何，增强输入使用独立的 `pdf-embedded-jpeg-v1` 身份，隔离旧渲染图片的增强结果；缓存命中无需再次提取。跳过结果只保留在当前有限增强窗口，重新进入时可重新检查，不新增持久元数据或跳过记录。

内嵌原图可能远大于显示图片；提取仅增加压缩字节读取和传输，不产生原页 RGBA 工作集。真实增强服务的上传大小、模型内存和耗时仍取决于原图及服务，插件不通过降低分辨率重试。原件导出与已有译图回退见[导出规范](COMIC_EXPORT_DESIGN.md)。

## 结果与缓存

完整本地文件、显式下载原图、自动页缓存、分段、缩略图和译图分别管理。清理普通缓存不删除完整源文件、主动下载资料和阅读进度。

每页实际取得字节后记录 SHA-256；PDF 渲染及图片规范化后的实际字节参与送译身份计算。图片变更重建当前内容身份，不按旧页码复用任务；重新打包的相同图片仍可按内容摘要复用本人有效翻译结果。不同来源的漫画不会因此合并。

客户端首次合成官方结果后缓存完整译图，命中时可直接离线读取；原图独立保留于来源／本地缓存，仅在译图缓存缺失、需要合成时恢复。后端鉴权、[账户内复用](READING_TRANSLATION_CONTRACT.md#账户内复用)与[文件保留](OBJECT_STORAGE.md)由各自契约统一定义，不提供漫画译本卡片、旧原文件或版本选择。

## 依赖与可重复验证

| 组件 | 锁定版本与来源 | 许可 |
| --- | --- | --- |
| [zip.js](https://github.com/gildas-lormeau/zip.js) | `@zip.js/zip.js 2.15.0`，使用本地 native streams 构建 | BSD-3-Clause |
| [node-unrar-js](https://github.com/YuJianrong/node-unrar.js) | `2.0.2`，内含 UnRAR `6.1.7` WASM | JS 包 MIT；UnRAR 使用其独立免费解压许可，包含禁止借此重建 RAR 压缩算法的条款 |
| [PDF.js](https://github.com/mozilla/pdf.js) | `pdfjs-dist 6.3.289`，legacy 主模块与同版本未压缩 Worker | Apache-2.0；内含 core-js `3.50.0`（MIT） |
| PDF 基础字体/字符映射/图像解码器 | 同一 PDF.js 包的 `standard_fonts`、`cmaps`、`wasm` | Foxit/PDFium BSD、Liberation SIL OFL 1.1、Adobe CMap BSD、QCMS MIT、OpenJPEG BSD 等；各自许可随构建打包 |
| [EPUB.js](https://github.com/futurepress/epub.js) | `epubjs 0.3.93`，按需导入 `src/book.js`，不使用整包 polyfill 入口；XML 传递依赖固定为 `@xmldom/xmldom 0.9.12` | BSD-2-Clause；xmldom 为 MIT；实际打包的传递依赖许可随构建保留 |

这些格式组件不包含模型权重。包下载地址与 SHA-512 integrity 在 [package-lock.json](../apps/extension/package-lock.json)；WASM、Worker、字体、CMap 的逐文件 SHA-256 在 [dependency-checksums.json](../apps/extension/public/import-assets/licenses/dependency-checksums.json)，其中还记录官方 UnRAR 6.1.7 源码包摘要。[UnRAR 许可](../apps/extension/public/import-assets/licenses/unrar.txt)与其他完整许可进入扩展和 Web 包。EPUB.js 的 ZIP／网络客户端不承担实际资源读取，原包和资源访问统一经过本地格式桥；其仍被打包的 JSZip、localforage 等代码保留原许可，不因运行时未使用而省略。

RAR 的 Emscripten 动态命名和 Embind 参数转换函数由 [unrar-csp.ts](../apps/extension/unrar-csp.ts)替换为静态闭包，保留参数转换、析构顺序和原 WASM。升级时构建检查会要求重新审阅。MV3 只增加本地 WASM 所需的 `wasm-unsafe-eval`，未允许 JavaScript `unsafe-eval`。Worker、字体、WASM 均随扩展发布，无运行时 CDN 依赖。

PDF.js 的主模块与 Worker 由 [pdfjs-csp.ts](../apps/extension/pdfjs-csp.ts)将 core-js 的旧 IE／WSH `Object.create` 回退替换为受支持浏览器均具备的原生实现，移除 ActiveX、动态 iframe 和脚本字符串拼接；保留其余 legacy 兼容逻辑，不提高现有浏览器版本要求。原代码段摘要不匹配时构建失败，升级依赖必须复核。内嵌原图提取由 `pdfjs-original-image.ts` 在同一 Worker 加入单页读取命令，调用本项目的 `pdf-original-image.mjs`；补丁核对整个上游 Worker 的 SHA-256，升级时必须重新验证解析与跳过规则。依赖清单记录上游文件摘要与此修改，Apache-2.0／MIT 许可继续随包保留。

扩展内 PDF 资源地址由 `runtime.getURL` 生成并保留原大小写；每个文档持有独立模块 Worker，在关闭或打开失败时释放，避免 PDF.js 按 HTTP 来源判断 Safari 扩展地址并回退到错误的 Worker 路径。

验证命令与产物位置见[脚本说明](../scripts/README.md#来源与阅读验收)。浏览器使用原创合成页，译图由隔离测试供应商产生，验证恢复及计费行为，不代表真实模型翻译效果。

## 缓存预算

完整源文件、主动下载不参与普通缓存淘汰；自动原图页、分段、缩略图和译图使用独立预算。官方与 MTU 译图预算均计入完整结果文件，官方覆盖文件不单独持久缓存。译图预算读取 `cacheLimitMb`，`-1` 表示无限制、零表示没有新增空间，调整预算会执行该缓存的清理。默认值与生效逻辑以[偏好](../apps/extension/src/comics/application/preferences.ts)和[译图缓存](../apps/extension/src/storage/translations/index.ts)为准。

无限制只取消译图缓存总量预算，仍受设备可用空间与浏览器存储配额约束；容器大小、解压资源和浏览器解码能力继续生效。手动清理译图始终保留原图、书架及阅读位置。
