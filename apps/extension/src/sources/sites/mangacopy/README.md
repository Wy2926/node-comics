# MangaCopy

支持 `mangacopy.com`／`copy4000.com` 的目录导入、12 小时更新、网页章节发现和原位翻译。站点身份、权限与入口在 `definition.ts`／`installation.json`；目录更新提示、缓存和阅读位置由公共应用层管理。

## HTTP 目录

`network.ts` 先请求 `/comic/<slug>`，读取专门标题、封面和内联 `ccz` 字面量，再请求同主机的 `/comicdetail/<slug>/chapters`。响应 `results` 前 16 个字符为 UTF-8 IV，其余为 AES-CBC 十六进制密文；使用网页给出的公开 `ccz` 本地解码，不下载或执行源站脚本，不创建目录标签页，也不回退到 DOM。协议依据：[源站目录脚本](https://s3.mangafunb.fun/static/websitefree/js20190704/comic_detail_pass202508141558.js)。

漫画 slug 来自详情页路径，章节 UUID 来自 `groups[*].chapters[*].id`。插件拼接 `mangacopy:<slug>:<UUID>`，不生成源站 ID。核对 `build.path_word`、分组 ID／数量、组内唯一章节和末章归属；空目录、缺项、重复、解码失败或取消均不覆盖旧目录。完整目录出现新章节 ID 才触发更新提示。

分组和类型名称取自 `groups`／`build.type`，不设分类白名单。仅 `default` 分组确定默认入口；同人、其他系列等当前漫画条目仍可阅读，不同分组／标签保持独立阅读序列。封面取自 `.comicParticulars-title-left img`，优先 `data-src`，其次 `src`；`*.mangafunb.fun` 仅申请可选权限。

## 章节与原位翻译

章节仍使用网页会话。`pages.ts` 保留正文页槽，`data.ts` 解码页面已有图片清单并核对页序；缺页保持部分结果，不自动滚动、翻章或处理登录挑战。原位翻译仅识别 `.comicContent-list img` 中已解码图片，保留短切片和重复 URL 的独立元素；不扫描目录、广告或推荐图。

## 验证

插件目录运行 `npm test -- src/sources/sites/mangacopy/tests tests/catalog-sync.test.ts tests/catalog-reader.test.ts`。按[脚本说明](../../../../../../scripts/README.md)配置隔离浏览器并构建后，运行根目录的 `scripts/verify_catalog_sync.mjs`、`scripts/verify_website_source_lifecycle.mjs`、`scripts/verify_source_covers.mjs`；覆盖 HTTP 目录、零目录标签页、后台 alarm、更新／失败保留、封面和阅读位置。原位回归设置 `INLINE_SITE_ONLY=mangacopy` 后运行 `scripts/verify_inline_translation.mjs`，使用合成网页和模拟译图。
