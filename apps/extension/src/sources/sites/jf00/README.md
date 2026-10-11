# 漫画猫（00jf）

本站逻辑仅在此目录，遵循[网站适配契约](../../../../../../docs/SITE_ADAPTERS.md)。

## 支持范围

- 精确主机 `https://www.00jf.com`；作品 `/comic_<作品 ID>.html`、章节 `/chapter_<作品 ID>_<章节 ID>.html`。章节自带作品身份，直接导入完整目录并选择该章节。
- 按名称查询源站搜索，保留原始完整作品名、作者及专用封面，按源站总数与每页 30 条核对分页。不推断搜索结果语言。
- HTTP 静态完整目录，按源站正序保留全部条目和标题，12 小时同步；不根据章节名推断正文／番外或重分组。
- HTTP 公开章节完整图片清单；保留重复 URL 的独立页槽，核对 SEO 归属、访问声明、图片序号、来源 CDN 与章节资源目录。不支持源站 VIP／付费章节。
- 专用封面来自 `.comic-cover-large`；支持 `comic.5um.net/comic/cover/`、`manga.5um.net/prod/` 封面，`manhua.5um.net/colatj/`、`manga.5um.net/prod/` 正文。未支持的资源主机或协议结构明确失败，不跨站兜底。
- 作品 `.comic-actions`、章节 `.reader-nav .nav-right` 嵌入导入／管理入口；网页仅已加载的 `.comic-content > img.comic-image` 支持原位翻译／原图恢复，DOM 不承担完整正文读取。

## 协议来源

源站作品页提供闭合的 `#chapter-list` 全量静态目录，正／倒序控制只重排该列表；原生 `/api/comic/chapter?mid=<作品 ID>` 的章节列表用于真实验收交叉核对，不为产品目录增加重复请求。不使用作品 JSON-LD 中未展开的计数模板。章节 canonical、BreadcrumbList 与 `readPic(作品 ID,章节 ID,VIP,金币)` 声明提供身份及公开访问证据；参数语义来自源站 `/template/pc/zizhi001/js/index.js`，闭合 `.comic-content` 给出整章图片，`alt` 标注原始页序。仅解析数据，不执行下载的源站脚本。搜索页给出总数、30 条分页、当前页与分页地址。

## 验证入口

在仓库根目录执行：

```powershell
npm --prefix apps/extension test -- src/sources/sites/jf00/tests
node apps/extension/src/sources/sites/jf00/tests/verify-http.mjs
npm --prefix apps/extension run build
node apps/extension/src/sources/sites/jf00/tests/verify-browser.mjs
node scripts/verify_inline_translation.mjs
```

单元测试使用脱敏夹具，覆盖 URL／伪造主机、能力及安装元数据、完整目录／归属、重复图片／缺页、搜索分页、取消、更新失败保留与页面会话失效。`verify-http.mjs` 访问真实公开源站和 CDN，验证搜索、长／短目录、完整正文、封面与图片字节；不调用产品 API 或模型。

`verify-browser.mjs` 使用构建好的 MV3 插件、新建隔离 profile 和真实公开源站，检查章节入口、完整目录导入、逐页解码、重开续读、封面和无源站标签页目录刷新。需安装 Playwright，`PLAYWRIGHT_MODULE` 可指定模块绝对路径，`TEST_CHROMIUM` 可指定支持加载解压扩展的 Chromium。`verify_inline_translation.mjs` 自动收集本站 `verify-inline.mjs`，验证原位显示／恢复、惰性与替换图片、位置和页面切换；源站及翻译后端均为隔离样本，不证明真实模型效果。

结果与截图写入忽略的 `artifacts/jf00/` 或公共原位验收产物目录。浏览器当前站点访问限制、撤权恢复与真实模型效果属于独立验收。
