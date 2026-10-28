# Read Comics Online

入口：[readcomicsonline.ru](https://readcomicsonline.ru/)。适配器 ID 为 `readcomicsonline`，由公共注册表自动收集。

## 支持范围

- 作品：`https://readcomicsonline.ru/comic/<slug>`；章节：`/comic/<slug>/<章节标识>`；源站分页阅读链接：`/comic/<slug>/<章节标识>/<页码>`。页码链接绑定整章，不生成另一章节，也不将网页页码写成插件阅读进度。
- 名称分页搜索、完整只读目录、整章图片清单、专用封面、12 小时目录更新，以及作品／章节浮动导入入口。原位翻译沿用通用已加载大图识别。
- 保留源站标题和章节标识的大小写，包括 `1.1`、`annual2025`、`Annual2025`、`Annual-2025`、`halloween-annual-2026`；不将同号特别版合并，不推断年刊的归属类型。阅读顺序按源站 `Read First`／`Next Chapter` 对目录倒序，全部条目使用同一阅读序列。
- 入口主要语言为 `en`，内容分类为欧美漫画；源站没有逐条声明内容语言，搜索和目录不推断语言。
- 只认领上述 HTTPS 主机与路径，不认领 `www`、其他镜像、CDN 页面或其他网站。

## 协议与访问条件

依据源站当前公开 HTML 独立实现，没有移植第三方适配器或执行下载的源站脚本。本地书本图标为项目原创 SVG。

- [首页](https://readcomicsonline.ru/)明确声明 DC／Marvel 漫画免费阅读；[Absolute Batman](https://readcomicsonline.ru/comic/absolute-batman-2024) 的普通期刊、特别版、年刊，以及[The Last Starfighter: Beta](https://readcomicsonline.ru/comic/the-last-starfighter-beta-2026) 的公开阅读行为支持 `free` 分类。网站目录包含欧美出版社及作品，故不归入日漫或日／韩生肉。不将 Cloudflare 验证视为账号或付费阅读门槛。
- 目录和章节通过已有 `pageTransport` 网页会话 HTTP 通道读取。普通无会话 HTTP 可能收到 Cloudflare 验证页；用户需在同一浏览器完成源站验证后重试。验证或解析失败明确报错，不返回空的完整目录，不覆盖已有目录和进度。
- 搜索使用 `/advanced-search?name=<名称>`，后续页增加 `page`。源站固定每页 60 个结果，适配器声明 `searchPageSize: 60`；按总数、当前页及明确的 `rel=next` 校验分页，不截断或读取后续页来拼接结果。通过 `searchPage` 复用已打开的同源网页会话；请在同一浏览器完成验证并保持网页打开后重试，不读取完整目录。
- 目录校验 canonical、作品标题、专用封面及 `Chapters` 的完整闭合静态列表。倒序后的第一项必须与 `Read First` 一致；重复章节、跨作品条目和未知分页结构拒绝导入。
- [章节页](https://readcomicsonline.ru/comic/absolute-batman-2024/1)同时包含单页显示区和隐藏的 `#reader-all` 完整条带。只用完整条带建立清单，逐项核对 `#page-list` 的页码地址、页数和图片 `alt`；两处显示的同一图片不会重复计页，条带内重复 URL 仍保留独立页槽。
- 章节归属同时核对 canonical、面包屑作品链接、已选章节选项及图片路径。标题空白统一规范化，保留源站实际文本。作品名交接仅读当前 DOM，不请求目录。
- 源站明确显示 `No pages uploaded yet` 的章节保留在目录中，读取时提示尚未上传图片，不返回空的成功清单，也不将它与其他年刊合并。
- 原图来自 `cdn.readcomicsonline.ru/uploads/manga/<slug>/chapters/<章节标识>/`；封面来自同作品的 `cover/cover[_宽x高].<后缀>`。保留图片查询参数。插件阅读器及封面使用 `no-referrer` 经公共 HTTP 管线直接读取，避免附加源站 Referer 的跨站请求触发 Cloudflare 验证。图片不需专用解码或图片页会话，原位读取仍遵循网页实际策略。
- 目录或章节各只请求一次 HTML，不下载整部作品或逐页 HTML。网页通道优先复用同作品标签页，必要时增加一次后台详情页导航；图片仍由公共阅读窗口按需读取。取消、请求预算和会话回收沿用公共运行时。

## 验证

在仓库根目录运行：

```sh
npm --prefix apps/extension test -- src/sources/sites/readcomicsonline/tests tests/site-directory.test.ts tests/comic-sites.test.tsx
npm --prefix apps/extension run check
npm --prefix apps/extension test -- --maxWorkers=4
npm --prefix apps/extension run build
npm --prefix backend/website run check
```

单元夹具为合成 HTML，覆盖身份／伪造主机、完整目录及失败保留、普通与特别版顺序、重复原图、缺页、章节归属、取消、搜索首页／末页／空结果和作品名交接；不包含漫画像素、凭据或源站全文。

真实检查使用上面的作品与章节链接；名称搜索可用 `Batman` 覆盖多页和末页。网页验证完成后核对真实响应解析、封面、正文首／中／末图片解码。完整阅读器验收需在桌面浏览器加载 `.output/chrome-mv3`，执行作品与章节链接导入、翻页、关闭重开、重复导入、目录刷新及失败后位置恢复；真实 HTTP 或图片下载不能代替这一流程。

网站目录界面可按[脚本入口](../../../../../../scripts/README.md)启动 `tests/site-directory.html`，检查欧美漫画筛选、域名搜索和中英文标签。该页面使用模拟导入失败，不代表 MV3 权限、源站读取或翻译模型效果。验证日志及截图放在忽略的 `artifacts/readcomicsonline/`。
