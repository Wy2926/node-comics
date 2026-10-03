# 文件索引与阅读会话

`indexFile(format, source, signal?)` 返回图片索引或 EPUB 文档索引。图片格式通过 `openDocument()` 返回可关闭会话，`index()` 输出 JSON 定位符，`materialize()` 只读取请求页。EPUB 通过 `openEpub()` 返回可关闭文档会话，原生文字排版不创建 PageDescriptor。调用方分别关闭格式会话和字节源。

## 模块规范

- 仅依赖通用 `RandomAccessSource`，不判断具体云盘，不读写书架或创建翻译任务。
- 图片 ZIP／RAR 解析、MOBI 正文处理放 Worker；PDF 按需以 144 dpi 渲染。EPUB 使用 zip.js native streams 有界读取，只在需要时解析章节及关联资源，不扫描全文或预展开全书。容器总量、展开字节、条目、页数、目录读取与操作时间均有界，单页不设固定字节、像素或边长门槛。
- 页身份保留重复引用的 occurrence；索引完成不等于取得图片字节。格式限制、依赖与许可见[格式规范](../../../../../docs/IMPORT_FORMATS_AND_CACHE.md)，公共上限定义见 [limits.ts](limits.ts)，读取协议见 [contracts.ts](contracts.ts)。
- EPUB 索引只保存 spine、目录、相对包内 href、封面与可翻译图片 manifest 定位；`readEpubImage()` 只读取已核验的单张包内位图，不渲染正文。可选 CFI、章节内比例及全书比例属于文档位置，不混用图片页码。续读优先使用 CFI，回退到包内 href 和章节内比例；显示用的全书比例按 spine 等权估算，不为百分比预扫描全文。EPUB.js 仅负责包结构与排版，所有资源经过本地归档桥和文档隔离器，不能直接联网；按章节持有的 Blob URL 在离章／关闭时释放，授权信号中止后立即销毁阅读文档。
- 完整文件、页缓存与下载由上层管理，见[来源架构](../../../../../docs/COMIC_SOURCE_ARCHITECTURE.md)。OPDS 的 CBZ/ZIP、未加密 MOBI 和 EPUB 在来源支持可靠 Range 时按需读取；EPUB 格式层只依赖随机字节源，不要求本地容器。Range 不可用以及 PDF、CBR 等需要完整文件时，由上层明确确认下载，不静默整包读取。章节资源复用来源分段缓存，不预取全文。

在插件目录运行 `npx vitest run src/comics/formats src/storage/containers src/comics/pages/service.test.ts tests/export.test.ts`。实际导入、解码与位置恢复使用[浏览器脚本](../../../../../scripts/README.md#来源与阅读验收)。
