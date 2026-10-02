# RawOtaku

入口：[rawotaku.com](https://rawotaku.com/)。适配器 ID 为 `rawotaku`，公共注册表按目录通配收集。

## 支持范围

- 作品：`https://rawotaku.com/read/<作品 slug>-raw/`；章节：`https://rawotaku.com/read/<作品 slug>/<语言>/chapter-<章节号>-raw/`。支持日文 slug、小数章节号及作品页的 `?read=1` 入口。
- HTTP 名称搜索、完整只读目录、章节原图、专用封面、12 小时目录更新，以及作品／章节网页的导入和管理入口。章节导入只打开目录中已确认的对应条目。
- 全部语言列表与声明的章节数逐一核对，包括默认隐藏的列表。保留源站章节名和语言分组；按源站下一章的前一兄弟节点关系转换为正向阅读顺序，各语言独立连读，不推断跨语言同话对应。
- 标签页翻译识别 `#vertical-content`／`#horizontal-content` 下 `.iv-card > img.image-vertical` 中已加载的原图，包括正文短切片。源站图片地址与 `data-src` 一致才认领，广告、封面、占位图、失败图和目录页不参与。懒加载、同元素换图及章节导航沿用公共会话和恢复规则。
- 仅支持当前公开漫画正文；登录、私有访问和 `data-auth` 图片协议不支持。访问失败、目录数量不一致或结构变化会明确报错。

## 协议来源

- 作品页的 `canonical`、`.anis-content`、`#chapters-list`、`.lang-item` 与 `.lang-chapters` 提供作品、专用封面、语言及完整章节列表；每条 `data-id` 是源站正文接口的章节 ID。
- 章节页 `canonical`、`.hr-manga` 与当前语言目录共同核对作品、章节号和远端 ID。
- 源站 `read.min.js` 的公开阅读流程请求 `/json/chapter?mode=vertical&id=<章节 ID>`，响应 `status: 1` 及正文 HTML 是整章列表。适配器仅解析这些数据，不执行源站脚本、不读取登录凭据。每章两次 HTTP 操作，逐页 `alt` 必须为连续零起始索引；重复图片地址保留不同页槽。
- 正文使用源站清单给出的 HTTPS 图片地址，不限制 CDN 域名；路径为 `/files/<漫画目录>/<章节目录>/<图片号>`，可无后缀或带 WebP／JPEG／PNG 后缀，同章目录须一致。封面取自作品专用海报，支持 `mgoimg.view47.com/thumb/.../upload/` 和 Backblaze `WCMS-Images/MangaOnline/p<id>`（可带 `.avif` 后缀及源站版本查询）。无需图片解码钩子或专用 Referer，读取使用公共图片管线。
- 名称搜索请求 `/?q=<名称>`，只解析主结果区；保留源站明确语言、封面与最新章节标签，重复作品链接按稳定身份去重。存在源站下一页链接时，游标限定同主机、同查询和页码。

## 验证

从仓库根目录运行：

```powershell
npm --prefix apps/extension test -- src/sources/sites/rawotaku/tests
node apps/extension/src/sources/sites/rawotaku/tests/verify-http.mjs
npm --prefix apps/extension run check
npm --prefix apps/extension run build
node apps/extension/src/sources/sites/rawotaku/tests/verify-browser.mjs
$env:INLINE_SITE_ONLY='rawotaku'; node scripts/verify_inline_translation.mjs
# 可选真实站点 DOM 和浏览器图片加载，送译字节及译图仍为本地夹具
$env:RUN_LIVE_RAWOTAKU='1'; node scripts/verify_inline_translation.mjs
```

HTTP 验证默认使用 [24 部公开作品清单](tests/live-samples.mjs)，覆盖热门长连载、完结作品、新作与不同分类。目录和正文经过公共契约校验；每个语言组抽取首／中／末章节及首末小数章节，检查全章页槽、图片路径，并实际读取每章首／中／末原图字节，另检查专用封面、名称搜索和空结果。最多两部并发，失败样本继续记录，最终存在失败则以非零状态退出。`RAWOTAKU_CATALOG_URL` 可改为指定单部作品。结果写入忽略的 `artifacts/rawotaku/http`，汇总作品、章节、目录条目、页数、CDN、图片格式与失败位置，不保存源站全文或凭据。清单未覆盖的语言与图片协议不能据此宣称已真实验证。

浏览器验证依赖已构建 MV3 扩展、`PLAYWRIGHT_MODULE` 与 `TEST_CHROMIUM`，`RAWOTAKU_READER_URL` 可指定章节，包括短章节和单页长图。在隔离配置中完成公共搜索与候选封面、真实网页章节导入、整章图片解码、重开恢复（第 10 页或不足 10 页时的最后一页）、封面、无源站标签页刷新及重复导入；目录失败使用模拟 HTTP。结果和截图写入 `artifacts/rawotaku/browser`。

原位验证由公共脚本自动发现，使用 `CHROMIUM_PATH` 指定浏览器；默认采用合成页面、任意 CDN 域名的无后缀图片和翻译 API，覆盖两种阅读模式、懒加载、换图、原图恢复、正文筛选和几何／滚动位置。可选真实模式核对源站 DOM 与浏览器实际加载的图片，`RAWOTAKU_READER_URL` 可指定章节，后台提交字节和覆盖结果仍为合成夹具。两种模式均不验证真实翻译模型、源站登录或浏览器安装／撤权恢复。
