# Asura Scans

支持 `https://asurascans.com/comics/<作品 slug>-<8 位小写字母数字后缀>` 及其 `/chapter/<话号>` 链接，包含小数话号。提供名称分页搜索、HTTP 完整目录、公开章节原图清单、专门封面及 12 小时目录同步；作品／章节页使用公共浮动导入入口，作品名称交接只读取当前页面元数据，原位翻译复用通用已加载大图识别。

只支持上述漫画路由；小说、旧域名、`/series/` 和短链接 `/s/` 不声明导入能力。其他站内页面仍可使用通用原位识图。目录和搜索不推断源内容语言，不把网站主要语言当成逐章语言证据。

## 协议与边界

实现依据[源站公开页面](https://asurascans.com/)及其静态 Astro SSR 数据，并对照 [Keiyoushi 的 AsuraScans](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/asurascans) 的独立实现。该源继承通用 `KeiSource`，不使用 Madara、MangaThemesia、ComiciViewer 或 GigaViewer 多站引擎；页脚 Toraka 署名及 Astro 框架不能作为共用漫画协议的依据，故目前不新增共享引擎。固定上游版本、文件摘要、用途和 Apache-2.0 许可见 [upstream.json](upstream.json)，未移植或运行 Kotlin／APK，既有上游许可随插件分发，本地图标为自制 SVG。

只解析 `astro-island` 的 `props` JSON 中已确认的普通值、对象和数组编码，不下载执行远端脚本，不访问账户、扣费、解锁或浏览量接口。上游的会员令牌读取、受限正文 API、推荐内容、偏好迁移和 `tiles` 分块还原不在本次范围；实际页面出现非空分块参数时明确报不支持，不能把打乱图当正常原图。

- 作品页以 canonical、`DescriptionModal.seriesId`、`ChapterListReact.publicUrl / seriesSlug` 和每条章节的 `series_id / series_slug` 交叉核对归属。`totalChapters`、详情计数及实际列表必须一致，才返回完整目录；不逐章抓取正文来构建目录。将源站完整倒序列表反转为阅读顺序，保留实际条目和小数话号，不补造缺话。
- 公开 URL 的 8 位后缀会变化，源站将旧后缀重定向至当前 canonical；作品身份使用 SSR 确认的 `seriesSlug`，章节身份使用作品与源站话号，后缀变化不重建书架或丢失位置。响应仍必须属于同一作品及章节，不能把其他重定向目标认作成功。
- 章节页没有 canonical，使用唯一 `ChapterReader` 的 `seriesSlug / chapterNumber` 绑定当前来源，读取其完整 `pages` 数组及自然尺寸；保留重复图片的独立页槽和实际顺序，不把页面广告／推荐图加入正文。若页面提供 canonical，则同样核对归属。锁定或未知访问状态、空清单和非法图片必须失败，不改用 DOM 图片绕过限制。
- 原图／封面仅接受源站提供的 `https://cdn.asurascans.com/asura-images/chapters/` 与 `/covers/` 栅格图片。保留图片查询参数；复用公共权限、Referer、响应大小、取消和缓存管线，无专用图片解码器。
- 名称搜索每次只读取 `/browse/comics?search=<名称>&page=<页码>` 的当前结果页。核对 `BrowseFilters` 的查询、漫画模式、当前页、总数及 20 条分页规则；不抓完整书库、不抓候选目录、不按语言过滤。空结果须有明确的零计数，验证页不能视为空结果。

目录及正文分别各需一次 HTML 请求，搜索每页一次；图片仍按公共阅读窗口加载，不预取整本。网页作品名称交接不请求目录，也不解码章节图片数组。页面结构变化时明确失败，已有目录、缓存及阅读位置由公共应用层保留。

## 目录标签依据

主要语言为英语译作，非生肉。[漫画浏览页](https://asurascans.com/browse/comics)及其 `type=manga / manhwa / manhua` 分类确认日漫、韩漫、国漫；[章节样本](https://asurascans.com/comics/return-of-the-mount-hua-sect-11fe7da3/chapter/1)确认纵向条漫内容。

收费类型为 `freemium`，访问标签为“需要登录”，只表示部分内容的限制，不表示公开章节均需登录。[源站 Asura+ 公告](https://asurascans.com/announcement/introducing-asura-mythic-series-reviews-and-more)明确包含 Premium 提前阅读，不能把它仅视为去广告会员。小说付费规则不用于声明漫画能力。适配仅读取源站当前返回的公开正文，遇到锁定提示用户等待或在源站处理；不自动购买，也不承诺登录后的会员章节可读。

## 验证入口

在仓库根目录执行：

```powershell
npm --prefix apps/extension test -- --run src/sources/sites/asurascans/tests
npm --prefix apps/extension run check
npm --prefix apps/extension test
npm --prefix apps/extension run build
```

隔离样本覆盖 URL／伪造主机、后缀变化、目录计数与章节归属、重复条目、重复图片、页序、受限章节、名称分页、取消、失败保留及轻量作品名交接；样本不保存源站正文或图片。

真实协议复核可搜索 `mount`，导入 `Return of the Mount Hua Sect`，检查完整目录、首尾公开章节与封面；搜索 `sword` 检查下一页，随机不存在的名称检查空结果。构建后用隔离 Chromium 加载 `.output/chrome-mv3`，检查名称搜索 → 导入 → 原图解码 → 两章分别跳页 → 关闭重开恢复，以及显式章节链接不重复建书。目录刷新故障需确认旧目录及位置保留。原位译图恢复、浏览器权限撤销／恢复、会员登录、Firefox／Edge 和真实模型效果分别验收，不能由 HTTP 或隔离单测结果代替。
