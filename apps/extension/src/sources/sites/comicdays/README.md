# Comic DAYS

支持 [Comic DAYS](https://comic-days.com/) 的名称搜索、作品封面、完整公开目录、章节导入、HTTP 正文读取、12 小时目录同步及网页浮动导入入口。作品身份来自源站 `series.id`，章节保留独立 `episode` ID；同一本作品只绑定一个来源。

## URL 与协议

- 作品入口：`https://comic-days.com/series/<作品 ID>/first_episode`。源站重定向到首话，适配器验证其作品归属；裸 `/series/<ID>` 不是作品详情页。
- 章节入口：`https://comic-days.com/episode/<章节 ID>`，可从章节元数据解析所属作品，包括暂不可读的付费章节。目录中的章节链接用 `#nodelane-days=<作品 ID>` 保留并验证作品绑定。
- 搜索：`/search?q=<名称>`，只读取候选结果，不请求候选作品目录。源站一次返回全部匹配，适配器每次展示 50 条，并用结果指纹校验后续游标；宽泛查询及其翻页仍需读取完整搜索响应。无结果的正常搜索页面使用 HTTP 404，须验证查询回显和空列表。
- 目录：通过 `aggregate_id` 请求 `/api/viewer/readable_product_pagination_information` 获取总数与每段大小，再按 `sort_order=asc` 读取 `/api/viewer/pagination_readable_products`，用首条章节的 `script#episode-json[data-value]` 验证作品身份、名称和专属封面，避免在公共 HTTP 读取中请求会重定向的作品入口。核对分段数量、章节唯一性和首章归属，多段目录再次核对总数及首尾段才声明完整。请求串行、无全站扫描、无独立缓存。
- 可读性：保留完整目录，用 `purchase_info.can_read` 标记源站当前可读状态。正文只读取源站当前返回的 `pageStructure`；未提供正文时明确报错，不解锁内容或购买章节。
- 图片：只接受 `https://cdn-img.comic-days.com/public/page/...` 正文和本站 `public/series-thumbnail/...` 专属作品封面。正文 `baku` 配方复用 [GigaViewer 图片引擎](../../shared/gigaviewer/README.md)，按原页槽保留重复图片和顺序；阅读器 HTTP 清单与原位翻译共用解码。

当前标签页显式接入共享 GigaViewer 页面引擎：先校验章节身份与 CDN 归属，再将 `episode-json` 正文页槽绑定到尺寸匹配的已加载画布。`baku` 画布通过公共 HTTP 管线读取原图并解码，不导出受跨域污染的画布；未知协议、缺失元数据或页槽错配不退回通用扫描。搜索、导入与完整目录仍由 HTTP 适配器独立提供。

公开协议样本：[宇宙兄弟作品入口](https://comic-days.com/series/10834108156628504270/first_episode)、[公开章节](https://comic-days.com/episode/12207421984001216436)。目录与可读状态随源站变化；登录购买态和真实翻译模型效果需要独立验证。

## 验证

在仓库根目录执行，浏览器环境变量见[公共脚本入口](../../../../../../scripts/README.md#来源与阅读验收)：

```powershell
npm --prefix apps/extension run check
npm --prefix apps/extension test
npm --prefix apps/extension run build
node apps/extension/src/sources/sites/comicdays/tests/verify-http.mjs
node apps/extension/src/sources/sites/comicdays/tests/verify-browser.mjs
$env:INLINE_SITE_ONLY = 'comicdays'
$env:RUN_LIVE_COMICDAYS = '1'
node scripts/verify_inline_translation.mjs
Remove-Item Env:INLINE_SITE_ONLY
Remove-Item Env:RUN_LIVE_COMICDAYS
```

单测覆盖 URL／伪造主机／作品归属、能力与安装元数据、完整目录与分页变化／重复／缺失、取消、锁定章节、搜索游标、空 404、页槽及解码。真实 HTTP 脚本检查分页目录、搜索、正文与专属封面；真实浏览器脚本在隔离的 MV3 插件中检查网站列表、搜索、网页导入、原图还原、页码恢复、重复导入与刷新，另外用模拟 HTTP 失败检查旧目录和进度保留。`COMICDAYS_READER_URL`、`COMICDAYS_SEARCH_QUERY` 可指定公开样本。

原位脚本默认使用污染画布、合成图片和本地模拟翻译服务，检查 HTTP 原图还原、失败页隔离、懒加载、原图恢复、几何位置及导航失效；`RUN_LIVE_COMICDAYS=1` 另外检查真实公开章节的画布识别、翻页、译图对齐和原图恢复。翻译服务始终模拟，不代表真实模型效果。HTTP／浏览器产物写入忽略的 `artifacts/comicdays/`，原位产物写入 `artifacts/inline-validation/`；不记录签名 CDN 查询参数。
