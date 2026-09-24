# 文件索引与逐页读取

`openDocument(format, source, signal?)` 返回可关闭会话；`index()` 只返回 JSON 定位符，`materialize()` 只交付请求页。会话不读写目录库、不查询译图、不创建翻译任务。调用方分别关闭格式会话和字节源。

| 格式 | 当前实现与资源上限 |
| --- | --- |
| CBZ/ZIP | zip.js 2.15.0 自定义随机 Reader；索引读取 16 MiB、单次取页压缩范围 40 MiB、展开页 32 MiB，目录 10000 项、漫画 1500 页、声明总展开 1 GiB；拒绝加密、分卷、ZIP64 和超过 1024 倍的条目。解析及解压在 Worker。 |
| PDF | PDF.js 6.3.289 自定义 range transport，关闭自动拉取与流式整文件获取；索引 16 MiB、页面准备 32 MiB 读取预算，逐页渲染最多 16 MP / 单边 8192，单个解析或渲染阶段 60 秒。 |
| MOBI | 未加密 MOBI6 / MOBI6+KF8；有限正文与 recindex 建索引，索引不读取图片资源。16 MiB 索引/正文预算、1500 页、图片 32 MiB，拒绝 DRM / HUFF / 独立 KF8。重复引用带 occurrence，保证一图多次出现时仍是不同页面。正文解析在 Worker。 |
| CBR/RAR | node-unrar-js 2.0.2 有界本地 Worker：压缩输入 128 MiB、声明总展开 256 MiB、目标页实际输出 32 MiB、WASM heap 256 MiB、操作 60 秒。逐页请求，立即清除库内部保留的展开输出；固实包仍可能解码前序数据。 |
| 内部图片解码 | 单页、最多 32 MiB；不是散图导入入口。 |

本地与云盘都不支持散图。远程登记开放 CBZ/ZIP、未加密 MOBI；MOBI 通过通用 `RandomAccessSource` 按记录读取，不依赖具体云盘。PDF、RAR 在格式入口明确拒绝，不能降级为下载整包。`capabilities.remote=false` 不表示本地格式不能阅读。

本地字节库固定为 `node-comics-reading-v1-container-bytes` / `chunked-idb-v1`，每块 1 MiB。复制期间增量计算 SHA-256；操作预约、块、ready 对象、引用和读取租约在一个新基线数据库中提交。完整文件不参加页面缓存 LRU。应用先登记导入 journal，传预建 contentId 到 `importContainer` 第四参数；重启按 journal 使用 `listContainerReferences` 点查已发布对象。复制未完成的过期暂存清理，bytesClosed 操作可继续发布。已有对象失踪时修复内容相同的容器，不丢弃新字节继续引用空对象。

已验证的自动化范围：真实 Store/Deflate ZIP、CRC 与加密拒绝、合成 MOBI、真实 UnRAR WASM + 自制 RAR4 Store 档案，以及 IndexedDB 并发去重、引用/租约、缺失修复、取消与恢复。MOBI 覆盖来源无关的本地/远程索引、模拟 Drive Range 的逐页读取、文件变化、撤权和拒绝整包回退；隔离 MV3 浏览器覆盖导入、解码、位置恢复和 DRM 错误。PDF 当前自动化是 range/按页渲染接口模拟；不能据此宣称任意 PDF、固实 RAR、真实 Drive 或三浏览器扩展重启均已验收。

在 `apps/extension` 运行：

```text
npx vitest run src/comics/formats src/storage/containers src/comics/pages/service.test.ts tests/export.test.ts
npx tsc --noEmit
```

导出使用页面租约串行读取。支持文件选择器时 ZIP/CBZ 直接写文件；缓冲下载和 PDF 上限 128 MiB。完整源文件导出直接读取容器分块，不解压重打包。隔离 UI 夹具为 `http://127.0.0.1:5176/tests/export-fixture.html`，须在该独立来源启动 Vite，使用新 profile；夹具仅生成自己的彩色样本。
