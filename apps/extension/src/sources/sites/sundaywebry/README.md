# Sunday Webry（サンデーうぇぶり）

支持 `https://www.sunday-webry.com/episode/<数字 ID>`。来源入口、名称搜索、完整分页目录、专用作品封面、章节正文和图片还原、12 小时目录同步、网页导入／管理入口及已加载正文的原位翻译均由本目录实现。

网站把作品信息与目录嵌在章节页，没有 `/series/<id>` 详情页。导入裸章节先校验 `episode-json.readableProduct` 的章节和作品身份，再读取完整目录。内部目录地址使用章节地址加 `#nodelane-webry-catalog=<作品 ID>`，目录条目使用 `#nodelane-webry=<作品 ID>`；片段不参与 HTTP 请求，作品按源站 series ID 去重。每次读取仍核对归属，源站跳转、错配或目录缺失均失败。

## 协议与范围

- 搜索使用源站 `/search?q=` 的完整结果页，读取作品名、作者与专用封面；不推断结果未提供的内容语言或最新话编号。空结果的 HTTP 404 必须仍带匹配查询和空结果结构。多于 50 项时在完整搜索结果内分页，游标绑定查询和结果摘要。
- GigaViewer 的 `/api/viewer/readable_product_pagination_information` 提供总数和分页大小，`/api/viewer/pagination_readable_products` 按 `aggregate_id`、`offset`、`limit`、`sort_order=asc` 获取目录。多页读取后复核总数和首页，拒绝缺页、重复条目及读取期间的变化。`purchase_info.can_read` 保留源站可读状态；仅限 App、非公开或已过免费期限的条目不伪装成可读。
- 正文使用章节 HTML 的 `episode-json`，只保留 `pageStructure.pages` 中 `type=main` 的页面；广告、链接和后记控制界面不作为正文。源页槽 ID 保留数组下标，重复图片地址仍是不同页。缺少正文、未知结构和图片来源不符明确失败。
- 正文解析、原位页槽绑定与 `baku` 还原复用 [GigaViewer 引擎](../../shared/gigaviewer/README.md)，保留既有清单的 `webry-baku` 处理标记。无混淆及 `usagi` 网络原图直接读取。协议依据来自[公开章节页](https://www.sunday-webry.com/episode/12207421984241764591)及其 GigaViewer 前端资源。随包图标为自制文字标识。
- 网页只选择 `.js-viewer-content > p.js-page-area` 的已加载正文。GigaViewer 的展示画布可能无法导出，因此 `baku` 目标通过公共取图权限与 Referer 管线读取 HTTP 原图，再调用本站 `image.decodeInline`；无混淆的页面资源继续绑定文档、元素和导航生命周期。译图显示与恢复由公共层维护，换章或元数据失配后旧目标失效。

网站公开目录和当前会话实际提供的正文是支持边界，不调用 App 私有接口，不执行购买、租借或解锁。官网的商店／宣传链接不是漫画来源。网络导入与刷新不需要保留源站标签页。

## 验证入口

在仓库根目录执行，浏览器环境变量见[公共脚本入口](../../../../../../scripts/README.md#来源与阅读验收)：

```powershell
npm --prefix apps/extension run check
npm --prefix apps/extension test
npm --prefix apps/extension run build
node apps/extension/src/sources/sites/sundaywebry/tests/verify-http.mjs
node apps/extension/src/sources/sites/sundaywebry/tests/verify-browser.mjs
$env:RUN_LIVE_WEBRY = '1'
node apps/extension/src/sources/sites/sundaywebry/tests/verify-browser.mjs
$env:INLINE_SITE_ONLY = 'sundaywebry'
node scripts/verify_inline_translation.mjs
Remove-Item Env:RUN_LIVE_WEBRY, Env:INLINE_SITE_ONLY
```

`verify-http.mjs` 访问真实公开搜索、分页目录、正文清单、首图与封面。`verify-browser.mjs` 默认使用合成夹具，检查无损解码、搜索导入、目录、重开位置、裸章节重复导入及刷新失败保留；设置 `RUN_LIVE_WEBRY=1` 则验证真实公开作品。`verify-inline.mjs` 由公共原位脚本自动发现，检查受污染画布、懒加载、恢复、失效目标与 SPA；同一开关额外检查真实网页切章。原位翻译响应始终来自本地模拟服务，不代表真实模型效果。截图和结果写入忽略的 `artifacts/`，浏览器原生权限对话框及付费账户状态另行验证。
