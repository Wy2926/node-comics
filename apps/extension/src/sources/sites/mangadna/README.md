# MangaDNA

入口：[mangadna.com](https://mangadna.com/)。适配器 ID 为 `mangadna`，由公共注册表按目录自动收集。

## 支持范围

- 作品链接：`https://mangadna.com/manga/<slug>`；章节链接：`https://mangadna.com/manga/<slug>/chapter-<源站标识>`，可带末尾斜杠。保留原始章节标识，包括 `chapter-175-8-8` 等特殊编号，不从 URL 推算章节数。
- HTTP 名称搜索与分页、完整只读目录、整章原图、专用封面、12 小时目录更新，以及作品／章节页的导入和管理入口。章节 URL 自带作品身份，导入只打开目录中已确认的条目。
- 作品详情页的嵌入入口位于 `.post-title` 标题下，章节页位于 `.c-breadcrumb`；共用“导入/管理漫画”和“寻找其他语言”按钮。重复点击详情页入口复用书架漫画并保持续读位置。
- 目录按照源站列表逆序阅读，保留章节标签；完全相同的重复链接合并，身份相同而标签冲突时拒绝。单一源站列表形成连读范围，不猜测同话版本、语言对应或章节分类。网站主要展示语言为英语；源站没有给出条目内容语言时不推断，`Raw` 标题也不转换成语言标签。
- 原位翻译只认领 `.read-content > img.loading` 中已加载、章节身份正确、`src` 与 `data-src` 一致的正文，包括短切片。广告、推荐、封面、未加载图和失败图不参与；懒加载、换图及导航沿用公共会话与恢复规则。
- 正文页槽取自源站 `alt` 的页码。重复图片地址保留独立页槽；页码缺口保留原位置，返回不完整标记和提示，不补造地址或重编号。缺页章节在重开、预载或继续下载时会重新请求章节 HTML 并更新页索引；已有页可读，整章下载保持待补齐。其余章节仍可独立读取。
- 只读取公开 HTML 和原图；访问失败、归属不符或结构变化时明确失败，不使用通用适配器读取漫画。

## 协议来源

- 作品页 `canonical`、`.post-title h1`、`.summary_image` 和 `#chapterlist .row-content-chapter` 提供身份、标题、专用封面和完整目录。源站“Show more”只改变列表显示，隐藏行仍包含在 HTTP 响应中。
- 章节页 `canonical`、`.breadcrumb`、`h1` 和 `.navi-change-chapter` 相互核对身份；顶部和底部导航重复出现，相同章节选项也可能重复。`.read-content` 是完整的公开图片列表，不执行源站脚本。
- 原图使用源站提供的 `https://cdn<编号>.mangadna.com/{uploads,chapters,online}/<漫画目录>/<章节目录>/<文件>` 地址，支持 JPEG／PNG／WebP／AVIF。核对同章路径和明确的数字章节标签，保留源站 URL；图片和封面沿用公共取图接口，无专用解码或请求头钩子。
- 搜索使用 `/search?q=<名称>&page=<页码>`，解析 `.listupd .home-item`，候选只返回身份、名称、专用封面和最新章节标签。`.blog-pager` 给出下一页，游标限定同主机、同查询和当前页；不读取候选完整目录。

## 验证

从仓库根目录运行：

```powershell
npm --prefix apps/extension test -- src/sources/sites/mangadna/tests
node apps/extension/src/sources/sites/mangadna/tests/verify-http.mjs
npm --prefix apps/extension run check
npm --prefix apps/extension run build
node apps/extension/src/sources/sites/mangadna/tests/verify-browser.mjs
$env:INLINE_SITE_ONLY='mangadna'; node scripts/verify_inline_translation.mjs
```

HTTP 验证默认采用 [8 部公开作品](tests/live-samples.mjs)，每部抽取首／中／末以及首末特殊编号章节，校验目录与页清单契约，读取章节首／中／末原图及专用封面，并检查搜索第二页和空结果。最多两部并发；仅连接重置等传输故障允许一次 GET 重试，重试数进入汇总。源站真实缺页单列为不完整章节；解析、HTTP 或图片失败保留并使脚本非零退出。`MANGADNA_CATALOG_URL` 可指定单部作品。需要本机 HTTP 代理时，用进程内的 `HTTPS_PROXY` 和支持环境代理的 Node 运行参数，脚本不修改系统设置。

浏览器验证需要构建后的 MV3、`PLAYWRIGHT_MODULE` 与 `TEST_CHROMIUM`，可选 `MANGADNA_TEST_PROXY` 只影响隔离浏览器。先检查真实作品详情页的嵌入按钮、点击导入和重复点击保持续读；再检查多页、单图长章节和源站缺页章节：真实网页导入、全部已提供原图解码、重开恢复、重复导入、关闭源站标签页后的刷新与模拟 HTTP 失败保留目录／位置。`MANGADNA_READER_URL` 可指定一个章节。

原位验证由公共脚本自动发现，使用 `CHROMIUM_PATH` 指定浏览器。网页、图片和翻译 API 为隔离夹具，检查正文筛选、短切片、懒加载、换图、原图恢复、几何和滚动位置；不代表真实翻译模型效果。

结果和截图写入忽略的 `artifacts/mangadna/` 或公共原位验证产物目录；不保存源站全文或凭据。浏览器安装／撤权恢复、登录内容及真实模型另行验证。
