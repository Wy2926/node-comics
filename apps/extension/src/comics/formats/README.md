# 文件索引与逐页读取

`openDocument(format, source, signal?)` 返回可关闭会话；`index()` 输出 JSON 定位符，`materialize()` 只读取请求页。调用方分别关闭格式会话和字节源。

## 模块规范

- 仅依赖通用 `RandomAccessSource`，不判断具体云盘，不读写书架或创建翻译任务。
- ZIP／RAR 解析、MOBI 正文处理放 Worker；PDF 按需渲染。输入、展开字节、页数、像素与操作时间均有界。
- 页身份保留重复引用的 occurrence；索引完成不等于取得图片字节。格式限制、依赖与许可见[格式规范](../../../../../docs/IMPORT_FORMATS_AND_CACHE.md)，上限定义见 [contracts.ts](contracts.ts)。
- 完整文件、页缓存与下载由上层管理，见[来源架构](../../../../../docs/COMIC_SOURCE_ARCHITECTURE.md)。远程仅开放 CBZ/ZIP、未加密 MOBI，不降级为整包下载。

在插件目录运行 `npx vitest run src/comics/formats src/storage/containers src/comics/pages/service.test.ts tests/export.test.ts`。实际导入、解码与位置恢复使用[浏览器脚本](../../../../../scripts/README.md#来源与阅读验收)。
