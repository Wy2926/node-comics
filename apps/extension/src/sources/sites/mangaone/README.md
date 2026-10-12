# Manga One（マンガワン）

支持 `https://manga-one.com/manga/<作品 ID>/chapter/first` 作品入口及 `/manga/<作品 ID>/chapter/<章节 ID>`。提供名称搜索、完整分页「作品一覧」目录、作品封面、公开免费正文读取／还原、网页浮动导入和 12 小时目录同步。源站没有 `/manga/<作品 ID>` 详情页；`choitashi` 加笔内容、单行本／杂志商店不作为连载目录导入。

标签页识图仅声明 `inlineRecognition: 'generic'`，没有专用 `page.ts` 或 `decodeInline`。已加载图片及同源 Blob 沿用通用尺寸、可见性和导航失效检查；源站撤销 Blob URL 后仍可读的图片复用公共 `shared/blob-image.ts`，不保留全尺寸像素缓存。导入分类不会限制通用标签页识图。

## 协议与边界

- 使用本站 `/api/client?rq=...` 的二进制响应。作品信息为 `title/list`，目录为 `viewer/chapter_list`，名称搜索为只读 POST `title/search`，正文为零消耗 POST `viewer_v2`。参数是 URL 查询，POST 正文为空；不执行下载的脚本、不提取或上传源站 Cookie／令牌。
- 目录按源站 `sort_type=asc`、每页 100 项读取，核对当前页、总页数、起止位置、总章节数及重复 ID，最多 10000 章。所有分页完整且总数一致才接受；失败或取消不改调用方的旧目录。章节字幕和原始排序保留，需道具的条目保留为不可读。目录／封面定位不请求正文。
- 正文核对响应作品和章节 ID，只保留 `pages.image`，排除带链接的广告及购买面板；重复图片保留独立页槽，广告间隙不重编号。图片必须属于响应章节的 `manga_page[_low]` 路径；版本化路径作为内容标识，签名更新不改变页身份。
- `.webp.enc` 图片按响应提供的 AES-256-CBC 参数在公共取图之后还原并校验栅格格式；不猜测密钥或未返回的图片。作品封面只取已校验作品记录的专用缩略图。
- 正文请求固定 `free_point=0`、`event_point=0`、`paid_point=0`，不传 CSRF 令牌、每日免费使用标记或用户 URL 中的购买参数。只接受 FREE 标记且不要求消耗体力、硬币、阅读券的章节；不承诺已购内容自动导入，不能访问时在源站处理阅读权限。
- 每次目录为一次作品信息请求加 `ceil(章节数/100)` 次目录请求，最初两次并发，后续分页串行。每章一次清单请求；图片按阅读器有限窗口读取。搜索一次返回轻量候选，不抓取各作品目录，以每 50 项游标展示。签名地址、还原参数及漫画字节不写默认日志或测试夹具。

协议依据为公开[作品入口](https://manga-one.com/manga/2275/chapter/first)、[章节](https://manga-one.com/manga/2275/chapter/207556)、[搜索](https://manga-one.com/search)及其 Web 客户端公开消息结构。解析器和还原实现为本项目独立实现，不复制第三方客户端代码；wire 基础复用 `shared/protobuf.ts`。图标为本地文字标识，不是官方 Logo。

## 验证

```powershell
# apps/extension
npx vitest run src/sources/sites/mangaone/tests/network.test.ts tests/source-generic-inline.test.ts src/sources/shared/blob-image.test.ts
npm run check
npm run build

# 仓库根目录；公开 HTTP，不使用账号或翻译模型
node apps/extension/src/sources/sites/mangaone/tests/verify-http.mjs
$env:INLINE_SITE_ONLY = 'mangaone'
node scripts/verify_inline_translation.mjs
$env:RUN_LIVE_MANGAONE = '1'
node scripts/verify_inline_translation.mjs
Remove-Item Env:INLINE_SITE_ONLY, Env:RUN_LIVE_MANGAONE
```

单元测试使用合成 Protobuf 和自制加密字节，覆盖主机／归属、分页完整性、锁定章节、零消耗请求、更新失败保留、签名刷新、取消、通用识图及还原。HTTP 入口检查多作品目录／搜索、免费章首尾图片及受限章失败，并只输出数量、体积和耗时。原位脚本使用[公共验收环境](../../../../../../scripts/README.md#来源与阅读验收)，模型响应为本地模拟；不以模拟译图证明真实模型效果。浏览器导入、阅读、目录错误及重开位置应另验，产物保存到忽略的 `artifacts/`。
