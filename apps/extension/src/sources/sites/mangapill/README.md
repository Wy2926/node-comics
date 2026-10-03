# MangaPill

入口：[mangapill.com](https://mangapill.com/)。适配器 ID 为 `mangapill`，由公共注册表自动收集，本目录保存全部站点规则。

## 支持范围

- 作品：`/manga/<作品 ID>/<slug>`；章节：`/chapters/<作品 ID>-<章节 ID>/<slug>`，使用源站当前提供的完整地址。数字 ID 决定身份，标题 slug 变化不生成另一部漫画或另一话。裸地址或过期 slug 会触发源站重定向，需先在源站打开并复制最终地址。
- HTTP 名称搜索、搜索分页、完整只读目录、章节原图、专用封面与 12 小时目录同步；作品页和章节页嵌入导入入口。
- 保留源站章节标题、顺序和显式 `Group N` 分段。源站目录为新到旧，阅读顺序按其 Previous／Next 关系反转；分段边界同样连读，不按章节数字去重或合并。
- 网站主要语言 `en` 只用于入口展示。源站结果没有声明逐条内容语言，因此搜索和目录不推断语言，也不改公共语言契约。
- 原位翻译只认领 `chapter-page img.js-page` 中已加载、属于当前作品和章节的原图；核对 `data-src`、页序声明与 `alt`。广告、封面、未加载图片和其他章节图片不认领。DOM 会话不承担完整正文发现。

## 协议依据

适配器解析源站公开服务器 HTML，不执行下载的脚本，不使用登录凭据。

- `/search?q=<名称>` 返回轻量作品卡片；仅沿源站明确的 `Next` 链接分页，游标绑定名称查询。不为搜索读取完整目录。
- 章节页面的作品链接是会重定向的裸地址。首次章节导入先读取章节中明确的作品名和 ID，再使用 `/quick-search?q=<作品名>` 的唯一数字 ID／专用封面匹配获取源站提供的完整作品地址，不由名称推算 slug。作品导入与后续目录刷新只请求完整作品地址。
- 章节条目用本地片段 `#nodelane-mangapill=<作品 slug>` 保留已确认的目录定位，数字身份不变；片段不发送给源站。首次章节定位需要两次 HTTP 读取，公共 30 秒响应交接可复用章节 HTML，使后续正文读取少一次请求。快速定位响应在上述四部代表作品中为约 4–55 KB；无需全站扫描或另存缓存。
- 作品页 `#chapters [data-filter-list]` 输出全量章节链接，无服务器分页。目录核对作品专用封面身份、标题、链接归属与重复章节；源站显式分段保留为目录组。
- 每个正文 `chapter-page` 声明 `page N/total`，图片 `alt` 声明同一页序。总数、全部槽位和声明必须一致，缺页明确失败；重复图片地址仍保留独立页槽。
- 章节归属同时核对 URL、章节选择器中的作品链接，以及图片路径中的作品／章节 ID。
- 图片使用 `cdn.readdetectiveconan.com`。旧路径为 `/file/mangap/<作品>/<章节>/<文件>`，新路径在作品 ID 前加入年／周，章节 ID 后加入版本 UUID。封面使用 `/file/mangapill/i/<作品 ID>.<图片后缀>`。源站的时间／版本查询保留。
- HTTP 原图和封面通过公共读取管线处理权限、Referer、重定向和字节识别，没有专用解码或全局请求规则。

## 验证

在仓库根目录运行：

```powershell
npm --prefix apps/extension test -- src/sources/sites/mangapill/tests
npm --prefix apps/extension run check
npm --prefix apps/extension test -- --maxWorkers=4
npm --prefix apps/extension run build
node apps/extension/src/sources/sites/mangapill/tests/verify-http.mjs
node apps/extension/src/sources/sites/mangapill/tests/verify-browser.mjs
$env:INLINE_SITE_ONLY='mangapill'; node scripts/verify_inline_translation.mjs
```

- 单元测试使用脱敏结构夹具，覆盖 URL 与资源归属、目录与搜索分页、页序完整性、重复图片、取消及页面会话失效。
- HTTP 验证默认读取 One Piece、Berserk、Choujin X、Look Back，按目录组抽样首／中／末和小数话，再读取章节首／中／末原图及封面字节。可用 `MANGAPILL_CATALOG_URL` 限定作品；最多两部作品并发。
- 阅读器验证使用当前构建的 MV3 扩展与独立浏览器目录，覆盖真实网页导入、整章图片解码、关闭重开续读、搜索、封面、关闭源站后的目录刷新、重复导入，以及模拟目录失败保留原数据和位置。可用 `MANGAPILL_READER_URL` 指定章节，依赖 `PLAYWRIGHT_MODULE`／`TEST_CHROMIUM`。
- 原位验证使用隔离网页、合成输入和模拟译图，检查懒加载、替换、失败、恢复、尺寸和滚动位置。设置 `RUN_LIVE_MANGAPILL=1` 可追加真实源站 DOM／原图加载检查；提交给翻译夹具的像素与输出仍为合成数据，不调用真实模型。原位脚本使用 `PLAYWRIGHT_MODULE`／`CHROMIUM_PATH`。

验证产物写入忽略的 `artifacts/mangapill/` 和 `artifacts/inline-validation/`。真实 HTTP、已安装扩展阅读、模拟翻译和模型效果分别验收；上述脚本不验证真实账号、付费服务或翻译模型效果。
