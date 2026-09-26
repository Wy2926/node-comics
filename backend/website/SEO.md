# 官网搜索与内容规范

官网面向寻找漫画翻译插件、浏览器漫画阅读器、安装方法及使用帮助的用户。支持简体中文 `/`、繁体中文 `/zh-tw/`、英文 `/en/`、日文 `/ja/`、韩文 `/ko/`。以下是基于实际功能的搜索意图规划，不代表已经取得搜索量或排名数据；上线后按 Search Console 的查询、国家、页面和设备数据修订。

## 关键词与页面分工

每个页面承接一个主要意图，相关词自然出现在标题、H1、正文、FAQ 和指南链接中。不要给所有页面套同一个标题或堆叠词组。Google 不使用 `meta keywords` 决定收录和排名，因此不输出该标签。[Google 元数据说明](https://developers.google.com/search/docs/crawling-indexing/special-tags)

| 页面（各语言使用相同路径结构） | 主意图／精准词 | 英文对应词 |
| --- | --- | --- |
| `/` | 漫画翻译插件、漫画阅读器 | manga translator extension, comic reader |
| `/features/` | 漫画逐页翻译、原图对照、本地阅读 | manga translation features, original comparison |
| `/download/` | Chrome／Edge／Firefox 漫画翻译插件下载 | manga translator Chrome / Edge / Firefox |
| `/pricing/` | 漫画翻译免费额度、PLUS 订阅价格 | free manga translation, translation plans |
| `/guides/` | 漫画翻译教程、本地漫画阅读指南 | manga translation guides, local comic reader guides |
| `/faq/` | 插件安装、支持格式、免费额度等具体问题 | manga translator FAQ, supported files, limits |
| `/help/` | 插件使用帮助、权限与登录问题 | manga translator help, extension troubleshooting |
| `/about/` | NodeLane 漫译品牌与用途 | about NodeLane Comics |
| `/changelog/` | NodeLane 漫译版本更新 | NodeLane Comics release notes |
| `/guides/manga-translation/` | 如何在浏览器翻译漫画 | how to translate manga in a browser |
| `/guides/translation-modes/` | 常规 OCR 翻译与 AI 重绘、本地翻译服务 | classic manga translation vs AI redraw, manga-translator-ui |
| `/guides/local-comics/` | CBZ／CBR／PDF／MOBI 漫画阅读 | CBZ reader, CBR reader, PDF / MOBI comics |
| `/guides/japanese-manga/` | 日语漫画翻译、原图对照 | Japanese manga translation, original comparison |
| `/guides/translation-troubleshooting/` | 漫画翻译失败、一直等待 | manga translation failed, stuck translation |
| `/guides/comic-reader-privacy/` | 漫画翻译图片上传、网站权限 | manga translator image uploads, extension permissions |
| `/privacy/` | NodeLane 漫译隐私政策 | NodeLane Comics privacy policy |
| `/terms/` | NodeLane 漫译服务条款 | NodeLane Comics terms of service |
| `/refund/` | NodeLane 漫译取消订阅、退款 | NodeLane Comics cancellation, refunds |

本地化用用户自然使用的词，不把英文关键词列表复制到其他语言：

| 语言 | 产品与安装词 | 教程与支持词 |
| --- | --- | --- |
| 简体中文 | 漫画翻译插件、漫画阅读器、浏览器插件下载 | CBZ 阅读、漫画翻译失败、本地翻译服务 |
| 繁體中文 | 漫畫翻譯擴充功能、漫畫閱讀器、擴充功能下載 | CBZ 閱讀、本機匯入、翻譯失敗、訂閱額度 |
| English | manga translator extension, comic reader | CBZ / PDF reader, local translation, translation troubleshooting |
| 日本語 | 漫画翻訳、漫画ビューア、ブラウザー拡張機能 | CBZ・PDF 閲覧、ローカル翻訳、無料枠、翻訳の失敗 |
| 한국어 | 만화 번역기、만화 뷰어、확장 프로그램 | CBZ·PDF 뷰어、로컬 번역、무료 이용량、번역 실패 |

不以“所有网站”“所有语言”“完全离线翻译”“无限速”等不符合实际能力的词引流。官网的五种语言与插件界面语言、模型目标语言是不同概念。

## 元数据与可抓取内容

- [src/i18n](src/i18n) 是五语内容来源。普通页面的 `seo*Title` 用于搜索标题，页面介绍用于 description 和可见正文；指南和政策使用自身的 `title`、`description`。首页摘要来自 [src/i18n/home](src/i18n/home)，标题和正文共同表明产品用途。
- [Base.astro](src/layouts/Base.astro) 输出每页自引用 canonical、五个互相对应的 hreflang 和简中 `x-default`；各语言保持独立可抓取 URL，不按 IP 或浏览器语言强制跳转。标题、摘要同步到 Open Graph 和 Twitter，并提供分享图和替代文本。[Google 多语言建议](https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites)
- [LocalizedPage.astro](src/components/LocalizedPage.astro) 输出产品 SoftwareApplication、指南 Article 和 FAQPage；公共布局包含 Organization、WebSite、WebPage、内页面包屑。只标记真实可见内容，不编造评分、销量或价格。指南内容更新时修改该篇 `updated`，不用构建时间冒充内容更新时间。
- [sitemap.xml.ts](src/pages/sitemap.xml.ts) 收录 18 类公开页面 × 5 语言，共 90 个 URL，并提供对应语言链接。账户、授权回调、支付返回和 404 页面使用 noindex，不进入站点地图。让爬虫能够读取 noindex，不用 robots.txt 屏蔽这些 HTML 页面。
- 首页商店入口直接使用可抓取的链接和本地浏览器标识；Chrome、Firefox 指向商店，Edge 审核期间进入当前语言的下载安装包位置。地址统一维护在 [site.ts](src/data/site.ts)，审核通过后只需填入准确详情页地址，并更新五语状态文案。

## FAQ

五语保持相同的 13 个主题 ID。问题、答案、相关页面均来自 `documents.faqs`；[FaqList.astro](src/components/FaqList.astro) 在静态 HTML 中输出完整答案，折叠不依赖网络请求。问题导航使用稳定锚点，正文链接到对应安装、定价、模式、格式、隐私或排错指南。首页展示其中四个安装与使用前常见问题，完整 FAQ 页输出与正文一致的 JSON-LD。

Google 已从 2026 年 5 月 7 日起停止展示 FAQ 富摘要，并在 6 月移除相关文档。保留 FAQPage 是为了描述内容；FAQ 的搜索价值来自具体问题、完整答案和内链，不承诺特殊搜索外观或排名加成。[Google 官方更新](https://developers.google.com/search/updates#may-2026)

## 验证与上线后观察

`npm test` 校验五语结构、FAQ 主题和相关页面；`npm run build` 校验全部静态 HTML 的唯一标题、公开页面摘要、canonical、多语言链接、站点地图、FAQ 正文与结构化数据一致性、三个浏览器入口及站内锚点。

发布后在有权限的 Google Search Console／Bing Webmaster Tools 中提交 `/sitemap.xml`，检查首页、下载、FAQ 及各语言代表页的抓取与 canonical；按查询查看展示、点击和点击率，判断是否需要调整文案。构建通过或本地浏览器验证不能证明线上已部署、已收录、实际排名提升或真实用户 Core Web Vitals 达标。
