# GigaViewer 共享引擎

由 Sunday Webry、Comic DAYS、少年ジャンプ＋、となりのヤングジャンプ、くらげバンチ、コミックガルド、webアクション、ゼノンプラス、コミックトレイル、マグコミ、COMIC OGYAAA!!、FEEL web、Seasons 显式复用，不按未知网页上的标记自动认领网站。站点传入来源身份、精确主机与资源策略；共享引擎不直接请求网络或调用浏览器 API。

- `pages.ts` 校验 `readableProduct` 章节身份与 `pageStructure`，保留正文页槽和顺序，排除引擎明确的链接、广告／其他内容与后记。站点传入章节地址和图片地址校验器；未知类型、模式、错配及不完整结构拒绝读取。
- `page.ts` 将同一文档的 `episode-json` 与正文页槽绑定，仅返回尺寸已匹配的已加载目标。元数据按原始字符串缓存（含失败），变更后重建；不做逐像素轮询或全章预取。当前窗口、并发、权限和译图显示仍由公共原位管线管理。
- `image.ts` 独立实现 `baku` 的 4×4、8 像素对齐转置，保留右／下剩余像素，解码结束释放位图和画布。`baku` 原位目标经公共 HTTP 管线取图还原；未混淆／`usagi` 仍读取文档绑定的已渲染像素，不把未知格式当作 `baku`。
- 默认处理标记为 `gigaviewer-baku:<宽>:<高>`；Sunday Webry 显式保留既有 `webry-baku` 命名空间，确保已保存清单继续可读。这是持久来源格式，不是翻译上传限制。

接入另一个已验证的同引擎站点时，在本站目录声明 `definition.ts`／`installation.json`、精确的章节与 CDN 范围，将经身份校验的产品交给 `gigaViewerPages`，并由 `gigaViewerPage`／`gigaViewerImage` 提供页面与图片能力。目录、搜索、封面和导入能力按实际实现独立开放；不复制还原算法，不允许任意 CDN，不为尚未验证的引擎变体增加配置。

## 分话目录与搜索

`identity.ts`、`serial-protocol.ts`、`serial-network.ts`、`serial-search.ts` 从既有 Comic DAYS 实现提取，供上述十二个分话适配器显式接入；Sunday Webry 保持原有搜索与目录。纯 URL 身份规则保留 Comic DAYS 的 `nodelane-days` 绑定，其余站点各有自己的命名空间，不合并同名作品。

- 目录通过源站 `readable_product_pagination_information` 的总数与每页大小串行读取 `pagination_readable_products`，核对数量、唯一章节和首话作品归属；多段再核对总数与首尾段，失败不修改调用方的旧目录。不请求会跳转的作品入口，无全站扫描和额外缓存。
- 目录仅包含 `type=episode` 的完整分话清单，不包含单行本或杂志。可读性只采用源站当前的 `purchase_info.can_read`，不是站点收费标签、`is_free` 或 `open_limit` 倒计时文案；限时开放章与常驻公开章使用同一读取流程。保留不可读条目，刷新目录后随源站更新状态；实际请求正文时仍须取得当前 `pageStructure`，不能因旧目录显示可读就放行。不请求购买、租借、阅读券或阅读计数接口。
- 搜索验证站点指定的路由或 SSR 媒体身份、查询回显、结果容器与作品封面。コミックガルド、webアクション、マグコミ与 Seasons 显式使用已验证的新版 SSR 搜索组件，只解析可见 HTML，不读取或执行 hydration 脚本；CSS 构建哈希不参与身份。启用混合商品模板的站点只跳过本站 `/volume/`、`/magazine/` 结果，不把这些商品当作分话作品。未知主机或结构报错。源站一次返回全部命中，UI 每页 50 条并校验结果指纹；翻页仍需重新读取该查询响应，不请求候选目录。
- 作品封面仅接受本站声明 CDN 的 `series-thumbnail`，可解包已验证的 GigaViewer 缩图包装；正文接受声明 CDN 的 `public/page/<资源>`、`public/page/<数字>/<资源>` 和 `public/page/filtered/<数字>/<资源>`。`filtered` 是已核实的正文资源路径，不是收费或限时状态；保留源站完整地址，仍按 `choJuGiga` 选择既有解码，不去除路径或绕过源站授权。图片算法、页面生命周期和公共读取预算不变。

协议依据为各站公开目录、搜索页与 `episode-json`；图片算法为项目独立实现。Keiyoushi 仅作协议参考，精确版本、文件摘要和用途见 [upstream.json](upstream.json)，Apache-2.0 许可随插件分发；未移植其 GraphQL 搜索、商品目录或全站枚举，不执行或打包 Kotlin／APK／源站脚本。

## 验证

公共单测在 `tests/engine.test.ts`，各站测试调用 `tests/serial-contract.ts`。源码测试覆盖分页完整性、限时开放／到期／再开放的状态变化、旧目录可读但正文已关闭、锁定状态、身份与资源归属、搜索游标、取消、重复页、未知格式、稳定扫描的解析次数、导航及资源释放。

从仓库根运行 `node apps/extension/src/sources/shared/gigaviewer/tests/verify-serial-http.mjs [site-id]`，省略 ID 验证十二个分话适配器；检查真实搜索、完整目录、正文、封面、空搜索和锁定章节拒绝。复用同一目录响应统计免费、已下架及购买／租借／订阅能力，不增加收费核查请求；免费站出现交易能力或未知字段时失败，须复核站点收费依据，不能自动改标签或把下架等同收费。该抽样检查不代替站点级官方说明。新版 SSR 搜索另用公开宽泛关键词检查两页不重复结果。固定样本、请求／字节预算见脚本，不记录签名图片 URL。

构建后运行 `node apps/extension/src/sources/shared/gigaviewer/tests/verify-serial-browser.mjs <site-id>`，使用[公共浏览器环境](../../../../../../scripts/README.md#来源与阅读验收)在隔离 MV3 中检查网站列表、搜索、网页导入、首图独立像素还原、首／中／末页、关页重开、重复导入与同步；注入 HTTP 503 检查旧目录和进度保留。HTTP 与浏览器脚本均可在指定一个站点时，用 `GIGAVIEWER_READER_URL`／`GIGAVIEWER_SEARCH_QUERY` 替换公开样本；HTTP 要求同时指定两项并核对章节、目录与搜索归属，输出源站 `open_limit` 供限时章核查。产物位于忽略的 `artifacts/gigaviewer/`。这些检查不使用真实账号或翻译模型，也不证明购买态、所有作品或原位译图效果；原位引擎的独立验证见各原有站点 README。

扫描开销对比：在仓库根运行 `node apps/extension/src/sources/shared/gigaviewer/tests/verify-performance.mjs <基准提交>`，用 38 页 DOM 桩对比基准 Sunday Webry 与当前共享引擎的稳定扫描及未知格式等待；不会请求网络，结果写入忽略的 `artifacts/gigaviewer-performance/`。此结果只衡量解析／目标绑定，不代表真实 DOM、解码或模型耗时。
