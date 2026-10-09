# KLManga

网站列表与搜索入口只显示 `klmanga.toys`。兼容 `klmanga.zone` 旧链接，网络读取统一使用新域名；两个域名共用作品与章节身份，已有书架记录不会因换域重复导入。旧域名的公开章节会重定向至新域名的同路径页面。

支持 `https://klmanga.toys/manga-raw/<slug>/` 作品详情及 `/manga-raw/<slug>/chapter-<章节标识>/` 章节链接。提供名称搜索、HTTP 完整目录、正文原图、作品封面、12 小时目录同步和作品／章节页浮动导入入口。标签页翻译通过 `inlineRecognition: 'generic'` 沿用通用已加载大图识别。

目录保留源站实际标题、小数话和发布条目，不补造缺话。同一章节 URL 与标题完全相同的冗余链接合并；身份相同而标题冲突时拒绝。主机、作品与章节归属严格校验；搜索、分类和首页不能导入。

## 协议与边界

协议来自 [KLManga](https://klmanga.toys/) 的公开 HTML 和网站自身的章节读取请求：

- 作品页 `.z-single-mg` 提供标题和 `.main-thumb` 专用封面，`.chapter-box` 返回完整静态目录。目录按源站前后章关系采用从旧到新的阅读顺序。
- 名称搜索使用 `GET /?s=<名称>`，只读取 `.grid-of-mangas` 中的作品候选；翻页沿用源站 `/page/<页码>/?s=<名称>` 链接。空结果必须有源站明确提示。
- 章节页核对作品链接、章节选择器与当前 URL。只读取内联脚本中公开的 `reading_chapter` 数字和 AJAX 地址，不执行下载脚本。
- 正文使用 `POST /wp-admin/admin-ajax.php`，表单字段为 `action=z_do_ajax`、`_action=decode_images`、`reading_chapter`、`img_index` 和 `content`。按响应 `next_timeout` 串行读取后续批次，只有 `going=0` 且索引与图片数量一致才能确认完整。`data-preload` 是图片加载提示，可缺省或不为 `yes`，不作为正文或页序证明；图片仍须有合法 `src`。
- 图片范围为 `https://p1.pubg-img.si[:183]/d/<资源>/<文件>`。支持源站返回的合并长图和多图清单；原始图片不按上传限制裁切或丢弃。图片权限、Referer、下载预算和解码由公共读取器负责。

分批正文会增加索引延迟：每批依赖前一批响应，继续读取需遵守源站等待间隔；单批合并长图无需等待后续请求。空正文、非法资源地址、页序不推进、跨作品章节、冲突重复目录或出现目录分页标记均明确失败；失败不修改调用方已有目录。

正文批次校验失败时，提示具体触发项以及起始索引、本批图数和返回索引；不包含原始 HTML 或图片地址，便于核对实际响应差异。

源站返回 `placehold.co` 的 `Fail Image` 占位图时明确报告源站原图读取失败，不将占位图导入正文，也不以继续批次证明缺失原图完整。

## 验证

在仓库根目录执行：

```powershell
npm --prefix apps/extension run check
npm --prefix apps/extension test -- --run src/sources/sites/klmanga/tests
npm --prefix apps/extension run build
node apps/extension/src/sources/sites/klmanga/tests/verify-http.mjs
node apps/extension/src/sources/sites/klmanga/tests/verify-browser.mjs
$env:INLINE_SITE_ONLY='klmanga'; node scripts/verify_inline_translation.mjs
```

契约单测使用隔离 HTML／JSON，检查 URL 与归属、目录完整性、搜索翻页、正文批次与重复图址、取消及失败保留。`verify-http.mjs` 请求真实公开站点与 CDN，检查搜索、目录、封面和正文图片字节；不代表浏览器阅读和权限验收。

`verify-browser.mjs` 使用隔离 Chromium profile 加载构建后的 MV3 扩展，默认读取 ONE PIECE 第一话的完整分批正文，检查搜索、浮动导入、整章原图解码、位置重开、重复导入、封面、关闭源站标签后的目录更新及模拟 HTTP 失败时保留位置。可用 `KLMANGA_CATALOG_URL`、`KLMANGA_READER_URL` 指定公开样本，`TEST_EXTENSION_DIR` 指定验收构建；长图位置回归用 `KLMANGA_READER_URL=https://klmanga.toys/manga-raw/hunter-x-hunter-raw-free/chapter-420/`。

`verify-inline.mjs` 由公共原位回归自动发现，使用合成网页、图片和翻译响应，检查通用大图识别、小图过滤、懒加载、原图恢复、位置与导航清理。真实模型效果与浏览器手动撤权／恢复另验。

浏览器环境见[脚本入口](../../../../../../scripts/README.md)：`PLAYWRIGHT_MODULE` 指定 Playwright 模块，阅读验收用 `TEST_CHROMIUM`，原位验收用 `CHROMIUM_PATH` 指定支持 MV3 的 Chromium。HTTP 验收使用 Node 原生 `fetch`，保留证书校验、请求超时和流式响应预算；默认包含 ONE PIECE 首章全部原图。HTTP 与阅读产物写入忽略的 `artifacts/klmanga/`，原位产物写入 `artifacts/inline-validation/`。
