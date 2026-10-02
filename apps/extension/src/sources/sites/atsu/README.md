# Atsumaru

入口：[atsu.moe](https://atsu.moe/)。适配器 ID 为 `atsu`，本站规则只保存在本目录，公共层通过通配收集接入。

## 支持范围

- 作品：`https://atsu.moe/manga/<id>`；章节：`https://atsu.moe/read/<作品 id>/<章节 id>`。读者位置片段保留，作品归属由 URL 与正文图片路径共同核对。
- HTTP 完整只读目录、章节原图、专用封面、名称／别名搜索、12 小时目录更新与浮动网页导入入口。
- 目录保留源站发布组，每个发布组按 `index` 独立连读。源站没有提供内容语言，不从名称、作者、类型或网站主要语言推断；不把不同发布组的同号章节合并。
- 原位翻译识别 `[data-reader-page][data-page-number] img` 中已加载的源站 HTTP 图片与本站 Blob 图片。HTTP 图片核对当前章节路径；广告、封面、未加载元素、其他章节的图片不认领，网页 DOM 不承担完整正文发现。
- `/novel/` 小说、登录功能和付费下载任务不支持。接口验证、访问限制与源站改版会明确失败，不切换另一抓取通道。

## 协议来源

本站公开客户端 `queryKeys`、`useSearch`、`staticImages` 模块使用以下无密钥接口。适配器只解析 JSON，不下载或执行源站脚本。

- `/api/manga/page?id=<id>` 提供作品、专用 `poster`、发布组和章节预览。`totalChapterCount` 是展示用的最高章节号，可以为小数，不是发布条目数，不能据此判断目录完整性。
- `/api/manga/allChapters?mangaId=<id>` 是源站客户端使用的完整目录接口；条目身份、发布组引用及组内顺序不得重复，并须包含作品预览中已确认的全部章节及其发布组归属。预览包含关系仅用于发现遗漏或错属，完整性依据来自全量接口契约。
- `/api/read/chapter?mangaId=<id>&chapterId=<id>` 是源站整章接口，返回 `readChapter.pages` 全列表；零起始 `number` 与页 ID 必须连续。该接口忽略 `mangaId`，图片仅允许 `cdn.atsu.moe/static/pages/<作品 id 或响应中的 scanlationMangaId>/<章节 id>/` 或 `cdn.atsu.moe/static/pages/<章节 id>/`。发布组和仅章节命名空间均额外读取作品元数据，确认响应中的发布组属于请求作品；作品命名空间图片直接核对作品路径。每章因此使用 1 或 2 次 HTTP 操作，不缓存独立目录状态。原位 DOM 没有发布组身份，按已识别章节路径校验。
- `/collections/manga/documents/search` 是源站公开 Typesense 代理，按名称和别名查询，仅过滤漫画媒介与源站隐藏条目，不按语言或成人属性过滤。分页游标绑定原查询。
- 封面仅接受 `cdn.atsu.moe/static/posters/`，HTTP 读取使用公共原图管线和源页面 Referer，无专用图片解码。

## 验证

在仓库根目录运行：

```powershell
npm --prefix apps/extension test -- src/sources/sites/atsu/tests
node apps/extension/src/sources/sites/atsu/tests/verify-http.mjs
node apps/extension/src/sources/sites/atsu/tests/verify-reader.mjs
$env:INLINE_SITE_ONLY='atsu'; node scripts/verify_inline_translation.mjs
# 真实公开 HTTP/CDN 的扩展搜索、导入、阅读、续读检查
$env:RUN_LIVE_ATSU='1'; node apps/extension/src/sources/sites/atsu/tests/verify-reader.mjs
```

HTTP 验证默认读取 `RkOOE` 的完整目录、每个发布组首尾可读章节的首张图片、专用封面及搜索分页；可用 `ATSU_CATALOG_URL` 覆盖作品地址。只用公开接口、浏览器 User-Agent 和源站 Referer，无 Cookie 或登录信息。结果写入忽略的 `artifacts/atsu/http`。

单元测试使用小型合成夹具及从 `RkOOE` 公开响应缩减、脱敏的目录样本，覆盖小数章节号与多发布组、URL 认领、伪造主机、预览遗漏／错属、目录预算／分组／更新失败保留、正文归属／页序／重复 URL、查询分页、取消、页面会话失效与原位筛选。浏览器入口 `verify-inline.mjs` 使用隔离页面和模拟译图，检查实际 DOM 选择器、懒加载、原图恢复、导航与几何位置，产物由公共脚本保存。

阅读器验证使用新构建的 MV3 扩展和独立浏览器目录，依赖 `PLAYWRIGHT_MODULE`／`TEST_CHROMIUM`；原位脚本使用 `CHROMIUM_PATH`。夹具模式覆盖搜索→导入→图片实际解码→发布组与章节切换→重开恢复、显式章节导入，以及目录失败保留条目／位置／当前图片和新增条目只计一次。`RUN_LIVE_ATSU=1` 改用真实公开 API 和 CDN，默认 `RkOOE`，支持 `ATSU_CATALOG_URL`；依据当前目录动态选择标题及跨发布组章节，并核对全量条目和发布组持久化。两种模式都不打开源站标签页，产物写入忽略的 `artifacts/atsu/`。

真实 HTTP 成功只证明当前公开接口和图片传输；隔离浏览器测试不证明真实源站登录、真实网页 SPA 操作、浏览器安装与撤权恢复或翻译模型效果。
