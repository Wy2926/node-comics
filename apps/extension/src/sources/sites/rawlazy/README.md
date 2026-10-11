# RawLazy

支持 `https://rawlazy.io/manga-lazy/<slug>/` 作品详情及源站日文章节链接。目录保留源站实际条目、标题和小数话，不依据章节号补造缺话。根路径旧章节可能没有作品身份，通过章节页 `.manga-name` 的作品链接和当前目录成员解析归属；阅读器条目使用本机片段 `#nodelane-rawlazy=<作品 slug>` 绑定已确认作品，该片段不发送到网站。

提供名称搜索、HTTP 完整目录、章节正文、作品封面、12 小时目录同步，以及作品／章节页浮动导入入口。已加载大图的原位翻译显式复用通用识别，不额外定义正文 DOM 筛选器。其他网站列表、标签或搜索页面不能导入。

## 协议与边界

协议来自 [RawLazy](https://rawlazy.io/) 的公开 HTML 与自身章节读取请求：

- 作品页 `.chapters-list` 在初始 HTML 内返回完整静态目录，按源站倒序转换为原生前后章链接的阅读顺序；封面只读取 `img[alt="Cover Image"]`。目录滚动窗口不作为分页依据。
- 名称搜索为 `GET /?s_manga=<名称>`，只解析 `.row-of-mangas .entry-tag`，单次最多 20 候选。源站未提供分页、作者或内容语言字段，不补造这些数据。无结果须有源站明确的 `Sorry, no manga found!`。
- 章节页的 `og:url`、作品链接与目录当前条目共同验证身份。`script#custom.js-js-extra` 的 JSON 提供公开 nonce；`decode_images` 调用中的数字 `p` 提供章节读取 ID。只读取脚本数据，不执行下载脚本。
- 正文使用 `POST /wp-admin/admin-ajax.php`，表单字段为 `action=z_do_ajax`、`_action=decode_images`、`p`、`img_index`、`content` 和 `nonce`；GET 不支持正文读取。按响应 `next_timeout` 等待并连续读取，每批最多 10 图，仅 `going=0` 且页序合法才能宣布完整。支持单张合并长图和普通多页正文，图片范围为 `https://p1.pubg-img.si[:183]/d/<资源>/<文件>`。
- 分批读取遵守响应中的等待间隔，章节索引延迟随批次数和等待时间增加；合并长图只需单批读取。读取受公共超时、取消和限额约束，不并发请求依赖前一批结果的正文。

空正文、非图片 HTML、非法地址、索引不推进、缺失身份、重复目录条目或出现目录分页标记均明确失败，不保存成完整清单。失败不修改调用方的旧目录；新 CDN、分页或读取协议需核实后再支持。

## 验证

在仓库根目录执行：

```powershell
npm --prefix apps/extension run check
npm --prefix apps/extension test -- --run src/sources/sites/rawlazy/tests
npm --prefix apps/extension run build
node apps/extension/src/sources/sites/rawlazy/tests/verify-http.mjs
node apps/extension/src/sources/sites/rawlazy/tests/verify-browser.mjs
$env:INLINE_SITE_ONLY='rawlazy'; node scripts/verify_inline_translation.mjs
```

`network.test.ts`、`search.test.ts` 使用隔离夹具验证 URL 与归属、完整目录、小数条目、批次页序、重复图址、取消、失败保留与候选范围。`verify-http.mjs` 使用系统 `curl` 的 IPv4／HTTP 1.1 通道请求真实作品／章节／搜索／封面与 CDN，保留证书校验，验证源站协议和实际图片读取；不能证明扩展浏览器安装权限和真实阅读交互。

`verify-browser.mjs` 在隔离 Chromium profile 中加载构建后的 MV3 扩展，请求真实站点与 CDN，验证搜索、浮动导入、全部原图解码、长图页内位置及重开恢复、封面、关闭源站标签后的目录更新、重复导入和模拟 HTTP 失败时保留位置；不调用翻译模型。可用 `RAWLAZY_READER_URL`、`RAWLAZY_CATALOG_URL` 指定公开样本，`TEST_EXTENSION_DIR` 指定构建。

`verify-inline.mjs` 由原位回归入口自动发现，使用合成图片／API 验证通用大图识别、小图过滤、懒加载、恢复原图、长图位置及导航清理；其中长图为 CSS 尺寸样本，不代表真实长图模型效果。浏览器运行环境及公共验证入口见[脚本说明](../../../../../../scripts/README.md)：`PLAYWRIGHT_MODULE` 指定 Playwright 模块，实际阅读脚本用 `TEST_CHROMIUM`、原位脚本用 `CHROMIUM_PATH` 指定支持 MV3 的 Chromium。浏览器手动撤权／恢复和真实模型效果另验。
