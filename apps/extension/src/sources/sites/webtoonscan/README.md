# WebtoonScan

- 作品 `/manhwa/<slug>/`、章节 `/manhwa/<slug>/<chapter>/`；章节标识保留数字、`chapter-`、小数和连字符，不按数字猜测或合并发布。阅读样式 `?style=list` / `?style=paged` 不改变章节身份。
- 名称搜索使用源站 `?s=<query>&post_type=wp-manga` 及 `/page/<n>/` 分页，每次只读一页轻量结果，不按语言筛选或推断结果语言。
- 读取详情页完整静态目录（包含折叠行）、专门封面和章节图片，支持 12 小时目录更新。封面支持 `data-lazy-src`／`data-src`，忽略 `noscript` 备用图片，仍校验作品归属和唯一有效封面。章节行内 `c-new-tag` 更新标记须指向同一章节，不作为额外章节或标题；完全相同的章节 URL 和标题去重，标题冲突或跨作品条目拒绝；源站缺失的章节不补造。
- 目录与正文显式使用公共网页会话 HTTP 通道，应先在源站完成可能出现的 Cloudflare 验证。搜索沿用直接 HTTP，受验证限制时明确失败并可重试，不自动换通道。普通命令行 HTTP 成功与浏览器会话成功不是同一验收项。
- 目录与搜索封面显式声明 `image.coverTransport: 'page'`，复用公共图片页会话读取原始字节；不改变正文／原位取图，也不在失败后切换通道。
- 正文请求固定列表样式；验证 canonical、当前章节选择项和正文标识，按完整 `reading-content` 中连续 `image-N` 页槽取图，保留重复 URL。图片只取正文容器，使用公共图片读取／Referer，不执行源站脚本；缺页、空列表、验证页、视频或未知分组不宣称完整。
- 网页提供公共浮动导入／管理入口。标签页识别仅声明 `inlineRecognition: 'generic'`，无专用 `page.ts`、选择器或通用层站点分支；沿用通用大图、懒加载与恢复规则。

协议来源：[WebtoonScan](https://webtoonscan.com/) 的公开 HTML（Madara 页面结构），包括 canonical、静态 `listing-chapters_wrap`、`single-chapter-select` 和 `reading-content`。未引入第三方代码；本地图标为自制识别图，不复制源站商标。

## 验证入口

插件目录执行 `npm test -- src/sources/sites/webtoonscan --maxWorkers=2`：脱敏结构夹具覆盖 URL／伪造来源、能力、目录重复与归属、完整性、重复图片、取消、失败保留和搜索分页。

仓库根目录执行：

```powershell
node apps/extension/src/sources/sites/webtoonscan/tests/verify-http.mjs
# 普通 HTTP 受限时，先用 browser-harness 打开本站并由用户完成必要验证，再复用该已授权标签页：
node apps/extension/src/sources/sites/webtoonscan/tests/verify-http.mjs --browser

# 先 npm --prefix apps/extension run build；需要 PLAYWRIGHT_MODULE 与 TEST_CHROMIUM
node apps/extension/src/sources/sites/webtoonscan/tests/verify-browser.mjs
$env:INLINE_SITE_ONLY='webtoonscan'
node scripts/verify_inline_translation.mjs
Remove-Item Env:INLINE_SITE_ONLY
```

HTTP 验证使用两部公开作品的完整目录、首末章节清单及分页／空搜索，只保存计数和结构结果，不保存正文。浏览器夹具使用隔离 MV3 和自制图片，检查网站入口、搜索、章节导入、网页会话读取、封面直取 403 时的图片页复用与字节一致性、原图解码、重开位置、重复更新与失败保留；不证明真实源站扩展全链路、首次新建来源／图片标签页、撤权恢复或模型效果。原位入口使用 `CHROMIUM_PATH` 指定浏览器，复用公共模拟翻译服务。产物写入忽略的 `artifacts/`；公共脚本环境见[脚本入口](../../../../../../scripts/README.md)。
