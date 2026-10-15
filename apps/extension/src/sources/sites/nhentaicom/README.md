# nHentai.com

适配 `nhentai.com`，不认领 `nhentai.net` 或其他同名域名。支持 `https://nhentai.com/<界面语言>/comic/<slug>` 详情页及其 `/reader`、`/reader/<页码>` 链接；界面语言包括 en、zh、id、fr、es、de、ru、hi、pt、ar。

整本画廊导入为一本漫画、一个阅读条目，提供完整原图清单、专门封面、网页浮动导入入口和 12 小时目录同步。页码链接指向同一阅读条目，不把每页建成一章；首次导入从整本起点阅读，后续沿用插件自己的阅读位置。不同界面语言使用同一作品身份，正文语言仅使用 API 明确标注，不从 URL 推断。

标签页翻译通过 `inlineRecognition: 'generic'` 沿用通用已加载大图识别，不增加 `page.ts` 或站点专用扫描器。未验证的分章作品明确拒绝，不将首章误报为全书；暂不提供名称搜索或 `/g/<id>` 短链接导入。收费类型为 `free`，依据[源站首页](https://nhentai.com/hentai-comics)关于免费在线阅读、所有作品可在浏览器逐页阅读的明确说明；不套用其他同名域名的规则。

## 协议与边界

协议来自 [nHentai.com](https://nhentai.com/en/hentai-comics) 页面自身的公开 JSON 请求，不复制或执行源站脚本。

- 目录读取 `/api/comics/<slug>?lang=<界面语言>&nsfw=false`，验证 slug、数字身份、页数、`chapters_count: 0` 和 `first_chapter: null`；封面只接受 `image_url` 中与作品数字身份一致的专门封面。
- 正文读取同一接口的 `/images`，验证所属作品、无分章状态和 `images.length === comic.pages`。使用源站 `page` 排序、图片 `id` 定义稳定页槽；页号重复、缺页、越界、资源跨作品即失败，重复原图 URL 仍保留不同页槽。不按文件名猜测后续图片，不请求缩略图或推荐作品。
- 适配器每次目录／正文操作各一个 API 请求，最多 1500 页；不缓存另一份目录或全尺寸图片。源站可能要求 Cloudflare 会话，因此显式使用已有 `pageTransport`。优先复用同作品标签页；没有可复用会话时，额外加载一个详情页，源站脚本也可能请求封面、缩略图等资源，完成后按公共生命周期回收自建会话。不提取 Cookie，不绕过验证、不自动切换通道；用户在同一浏览器完成验证后重试。
- 原图与封面沿用公共 HTTP 取图、权限、Referer 和缓存管线，无专门解码或请求头。`nsfw=false` 保留实测网页请求参数，不修改源站设置。

## 验证

在 `apps/extension` 执行：

```powershell
npm run check
npm test -- src/sources/sites/nhentaicom/tests tests/source-generic-inline.test.ts tests/source-architecture.test.ts
npm run build
```

单测为自制 JSON 夹具，覆盖 URL／语言身份、封面和正文归属、重复图址、缺页与页序、目录完整性、请求次数、取消和失败保留。通用识图测试随静态注册表自动覆盖本站，不调用源站或翻译模型。

真实响应解析：启动 `npx vite --host 127.0.0.1 --port 5181 --strictPort`，打开 `/src/sources/sites/nhentaicom/tests/probe.html`，输入浏览器公开接口的原始 JSON 和相应详情／阅读 URL。该页面只在本地解析并执行公共契约校验，不获取图片、执行源站脚本或调用翻译。

真实扩展仍需单独验证浮动导入、取图、重开位置及浏览器会话的验证／撤权／恢复；解析成功或网页预览不能代替已安装扩展验收。通用浏览器夹具见[脚本入口](../../../../../../scripts/README.md)。
