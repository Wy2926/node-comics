# MangaDot

支持 `https://mangadot.net/manga/<作品 ID>`、`/chapter/<章节 ID>`、`/chapter/<上传 ID>?source=user` 及 `/volume/<上传 ID>`。HTTP 读取作品、完整多语言目录、专门封面和正文；12 小时同步不打开源站标签页。网页作品／阅读页提供导入入口，已加载正文图片支持原位翻译；作品页提供可靠名称用于寻找其他语言。

作品使用 `mangadot:<ID>`。普通章节、上传章节、整卷分别保留 `scraper:chapter`、`user:chapter`、`user:volume` 身份，不能丢失 `source=user` 查询参数。裸章节／卷链接通过图片接口的作品与发布身份解析归属，再由公共层核对完整目录。目录链接附加本地作品绑定片段，不发送到源站。

`/api/manga/<ID>` 提供元数据；`/chapters/list` 和 `/volumes` 返回完整数组，不发送语言／发布组筛选。以源站章节号、卷号分别分组并核对作品总数，重复身份、缺失目录或错误格式使刷新失败。源站按同一 `chapter_number` 合并多语言与发布组，适配器沿用此关系提供同话位置，按话号、发布时间和稳定身份排序。整卷使用独立阅读序列，不推断单话属于哪一整卷。`language` 保留实际内容语言，缺失时不猜；`zh`、`zh-hk` 分别规范为 `zh-Hans`、`zh-HK`。零页发布保留在目录并标为不可读；语言选择、独立进度和更新徽章交公共层处理。

`/api/chapters/<ID>/images` 读取普通章节，`/api/uploads/<ID>/images` 读取上传章节及整卷。核对作品、发布 ID、来源、类型、审核状态和 `page_count`；保留数组顺序及重复 URL 的独立页槽。当前图片只接受源站 `/chapters/manga_<作品 ID>/…` 地址，封面只接受 `/uploads/…`。不把分享海报、章节封面或临时 URL 当作品封面／稳定内容摘要。

名称搜索使用 `/api/search?search=…&limit=12&sortBy=relevance&sortOrder=desc`，沿用源站模糊相关度与不透明 `next_cursor`，游标绑定本次查询。每次只取一页，不查询候选目录；不发送语言筛选。最新话号取自 `latest_chapter_number`，保留小数话号，缺失时不猜。结果目前未提供作者或实际章节语言，因此不以 `country_of_origin` 猜测语言。网页种子仅使用身份一致的 `og:url`／`og:title`。

所有 API 请求通过公共传输使用同源 Referer，浏览器自带 User-Agent；不提取或转发 Cookie／令牌。Cloudflare 仍可能要求在源站完成验证，403 按公共错误流程提示重试，不自动打开采集标签页或执行挑战脚本。当前公开图片接口可直接读取；若源站重新要求签名令牌，明确失败而不绕过校验。此类站点访问限制无法由适配器保证始终消除。

协议依据为源站作品、搜索、阅读页及其公开前端 `useChapterList`、`MangaDetailPage`、`SearchPage`、`ChapterReaderPage`、`readerHref` 和 `chapter-language` 请求／分组行为。实现只解析 JSON，没有复制或执行源站脚本；图标为项目自绘。

验证命令：

```powershell
# apps/extension 下：类型、边界、单元测试和构建
npm run check
npm test
npm run build

# 仓库根目录：真实公开 HTTP，覆盖英／法／西语、整卷、封面、搜索分页和空结果
node apps/extension/src/sources/sites/mangadot/tests/verify-http.mjs

# 仓库根目录：已构建扩展，隔离浏览器与合成接口／图片
node apps/extension/src/sources/sites/mangadot/tests/verify-reader.mjs
$env:INLINE_SITE_ONLY = 'mangadot'
node scripts/verify_inline_translation.mjs

# 真实公开接口与图片的扩展搜索→导入→阅读→语言切换→重开恢复
$env:RUN_LIVE_MANGADOT = '1'
node apps/extension/src/sources/sites/mangadot/tests/verify-reader.mjs
```

浏览器使用 `PLAYWRIGHT_MODULE`／`TEST_CHROMIUM`，原位脚本使用 `CHROMIUM_PATH`；产物位于忽略的 `artifacts/`。HTTP 探针使用浏览器 User-Agent 与 Referer，不读取本机 Cookie。隔离阅读器另测目录失败保留及新增条目只计一次；原位脚本使用合成翻译响应，不代表模型效果。真实阅读器脚本不打开源站网页，不能替代真实网页 SPA 原位操作、浏览器安装权限或撤权恢复验收。
