# GigaViewer 共享引擎

由 Sunday Webry 与 Comic DAYS 显式复用，不按未知网页上的标记自动认领网站，也不提供引擎自己的来源身份、目录、权限或网络请求。

- `pages.ts` 校验 `readableProduct` 章节身份与 `pageStructure`，保留正文页槽和顺序，排除引擎明确的链接、广告／其他内容与后记。站点传入章节地址和图片地址校验器；未知类型、模式、错配及不完整结构拒绝读取。
- `page.ts` 将同一文档的 `episode-json` 与正文页槽绑定，仅返回尺寸已匹配的已加载目标。元数据按原始字符串缓存（含失败），变更后重建；不做逐像素轮询或全章预取。当前窗口、并发、权限和译图显示仍由公共原位管线管理。
- `image.ts` 独立实现 `baku` 的 4×4、8 像素对齐转置，保留右／下剩余像素，解码结束释放位图和画布。`baku` 原位目标经公共 HTTP 管线取图还原；未混淆／`usagi` 仍读取文档绑定的已渲染像素，不把未知格式当作 `baku`。
- 默认处理标记为 `gigaviewer-baku:<宽>:<高>`；Sunday Webry 显式保留既有 `webry-baku` 命名空间，确保已保存清单继续可读。这是持久来源格式，不是翻译上传限制。

接入另一个已验证的同引擎站点时，在本站目录声明 `definition.ts`／`installation.json`、精确的章节与 CDN 范围，将经身份校验的产品交给 `gigaViewerPages`，并由 `gigaViewerPage`／`gigaViewerImage` 提供页面与图片能力。目录、搜索、封面和导入能力按实际实现独立开放；不复制还原算法，不允许任意 CDN，不为尚未验证的引擎变体增加配置。

协议依据为两个站点公开章节的 GigaViewer 阅读器及 `episode-json`；算法为项目独立实现，不执行或打包源站脚本。各站真实验证入口见站点 README；公共单测在 `tests/engine.test.ts`。源码测试覆盖稳定扫描的解析次数、重复页、未知格式、错配、导航及资源释放；浏览器测试使用隔离扩展和本地模拟翻译，不代表真实模型效果。

扫描开销对比：在仓库根运行 `node apps/extension/src/sources/shared/gigaviewer/tests/verify-performance.mjs <基准提交>`，用 38 页 DOM 桩对比基准 Sunday Webry 与当前共享引擎的稳定扫描及未知格式等待；不会请求网络，结果写入忽略的 `artifacts/gigaviewer-performance/`。此结果只衡量解析／目标绑定，不代表真实 DOM、解码或模型耗时。
