# 文件格式

`indexFile()` 创建索引；图片用 `openDocument()`，EPUB 用 `openEpub()`。调用方关闭会话和字节源。

- 只依赖 `RandomAccessSource`，不访问云盘、书架或翻译任务。
- 按页/章节读取，不预展开整书；图片页码与 EPUB CFI 分开保存。
- EPUB 资源经本地归档桥与隔离器，不能直接联网；窗口淘汰时释放文档和 Blob URL。
- 格式限制见 [limits.ts](limits.ts)，读取协议见 [contracts.ts](contracts.ts)。

插件目录验证：`npx vitest run src/comics/formats src/storage/containers src/comics/pages/service.test.ts tests/export.test.ts`。
