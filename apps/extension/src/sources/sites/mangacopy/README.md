# MangaCopy

支持 `mangacopy.com`／`copy4000.com` 的目录导入、12 小时更新、网页章节发现和原位翻译。站点身份、权限与入口在 `definition.ts`／`installation.json`；目录更新提示、缓存和阅读位置由公共应用层管理。

## HTTP 目录

`network.ts` 先请求 `/comic/<slug>`，读取专门标题、封面和内联 `ccz` 字面量，再请求同主机的 `/comicdetail/<slug>/chapters`。响应 `results` 前 16 个字符为 UTF-8 IV，其余为 AES-CBC 十六进制密文；使用网页给出的公开 `ccz` 本地解码，不下载或执行源站脚本，不创建目录标签页，也不回退到 DOM。协议依据：[源站目录脚本](https://s3.mangafunb.fun/static/websitefree/js20190704/comic_detail_pass202508141558.js)。

漫画 slug 来自详情页路径，章节 UUID 来自 `groups[*].chapters[*].id`。插件拼接 `mangacopy:<slug>:<UUID>`，不生成源站 ID。核对 `build.path_word`、分组 ID／数量、组内唯一章节和末章归属；空目录、缺项、重复、解码失败或取消均不覆盖旧目录。完整目录出现新章节 ID 才触发更新提示。

分组和类型名称取自 `groups`／`build.type`，不设分类白名单。仅 `default` 分组确定默认入口；同人、其他系列等当前漫画条目仍可阅读，不同分组／标签保持独立阅读序列。封面取自 `.comicParticulars-title-left img`，优先 `data-src`，其次 `src`；`*.mangafunb.fun` 使用插件统一的网站访问权限，读取时仍校验实际权限与图片地址。

## 搜索

依据两个已适配入口的公开 `/search?q=` 页面，使用同主机 `/api/kb/web/searchci/comics?offset=0&platform=2&limit=12&q=<关键词>&q_type=`。校验 `code`、`results.list/total/limit/offset`、作品 slug 与重复身份；每次只读 12 项，游标是偏移量，公共层绑定查询上下文。两个入口返回同一 `mangacopy:<slug>` 身份，由公共层去重。结果未提供语言时不声明语言，不根据站点或标题推断正文语言。

作品页查找种子来自 `.comicParticulars-title-right h6`，不读取完整目录；章节页混合的 `作品/卷名` 不拆分，标题不可靠时由用户填写。

## 章节与原位翻译

章节仍使用网页会话。`pages.ts` 保留正文页槽，`data.ts` 解码页面已有图片清单并核对页序；缺页保持部分结果，不自动滚动、翻章或处理登录挑战。原位翻译仅识别 `.comicContent-list img` 中已解码图片，保留短切片和重复 URL 的独立元素；不扫描目录、广告或推荐图。

## 验证

插件目录运行 `npm test -- src/sources/sites/mangacopy/tests tests/catalog-sync.test.ts tests/catalog-reader.test.ts`。按[脚本说明](../../../../../../scripts/README.md)配置隔离浏览器并构建后，运行根目录的 `scripts/verify_catalog_sync.mjs`、`scripts/verify_website_source_lifecycle.mjs`、`scripts/verify_source_covers.mjs`；覆盖 HTTP 目录、零目录标签页、后台 alarm、更新／失败保留、封面和阅读位置。原位回归设置 `INLINE_SITE_ONLY=mangacopy` 后运行 `scripts/verify_inline_translation.mjs`，使用合成网页和模拟译图。

根目录运行 `node apps/extension/src/sources/sites/mangacopy/tests/verify-search-http.mjs`，验证两个入口的实时第一页／下一页及空结果；产物位于忽略的 `artifacts/mangacopy/search-http/`。`search.test.ts` 覆盖合成协议、身份、编码、取消及作品种子；HTTP 探针不验证浏览器安装权限与撤权恢复、搜索 UI、导入或名称模型。
