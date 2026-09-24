# NAVER Webtoon

支持 `https://comic.naver.com/` 桌面站的 `webtoon`、`bestChallenge`、`challenge` 三类作品：

- `/<分类>/list?titleId=<作品 ID>`：完整公开目录、直接导入、手动刷新和每 12 小时自动检查更新。
- `/<分类>/detail?titleId=<作品 ID>&no=<话 ID>`：后台读取完整正文图片清单，按需取图；嵌入按钮导入整本漫画，并提供当前话作为初次阅读入口。已有漫画继续使用已保存的阅读位置。
- 详情页和阅读页显示 **NodeLane Comics · 导入/管理漫画**，文案跟随插件界面语言。首次通过插件弹窗导入，或在“漫画网站”粘贴作品链接并添加时，请求 Naver 与正文 CDN 的可选权限；授权后自动登记内容脚本，已打开和后续打开的网站都显示按钮。未授权时不会自动注入，也不扩大安装时必需权限。

目录、更新、章节发现和图片获取全部使用扩展 HTTP 请求，不创建源站采集标签页。用户点击按钮仅打开插件自己的阅读器。

标签页原位翻译识别 `.wt_viewer` 中已加载的 `content_image_N` 正文切片，按编号排列，重复 URL 保留独立元素，短切片也参与翻译；年龄提示、广告与推荐图不参与。懒加载和换图会重新识别，目录与其他页面不回退通用扫描。2026-09-24 核对真实 Webtoon `758037/1` 容器后，隔离 MV3 的显示、懒加载、错误恢复、原图恢复和位置保持通过。此次输出来自模拟翻译服务，未验真实模型效果。

定向原位回归：配置公共 `PLAYWRIGHT_MODULE`／`CHROMIUM_PATH` 后，在仓库根目录设置 `INLINE_SITE_ONLY=naver`，运行 `node scripts/verify_inline_translation.mjs`。

## 来源协议与边界

2026-09-23 从真实桌面站核实：

- 作品信息：`GET /api/article/list/info?titleId=...`。
- 目录：`GET /api/article/list?titleId=...&page=...&sort=ASC`。检查 `titleId`、`webtoonLevelCode`、分页总数、页码、页长、ASC 顺序和唯一话 ID；多页读取后重新检查第一页，发现发布期间变化则整次失败，保留旧目录。三类来源分别使用命名空间，不将作品晋级分类推断为镜像地址。
- 阅读页是服务端 HTML：只解析唯一 `.wt_viewer` 内连续编号的 `content_image_N`，排除年龄提示、缩略图与广告；保留重复图片 URL 对应的独立页槽。当前 `aria-current` 话链接须与请求的分类、作品及话 ID 一致；正式 Webtoon 图片路径还须含正确的作品／话 ID。投稿图片路径使用真实观察到的 `user_contents_data/challenge_comic` 格式。
- 图片主机仅允许 `image-comic.pstatic.net`，通过公共图片接口为精确 URL 临时设置 Naver Referer。页面脚本不执行，网络请求不携带账号 Cookie，原图不上传给源站之外的服务来完成导入。
- “完整目录”指接口的 `articleList / totalCount` 所描述的网站公开目录，不包括单独的付费预览入口 `chargeFolderArticleList`。需要登录、年龄验证、购买、App 或受地区限制的内容会明确失败，不自动打开验证页、不隐式切换通道。移动站与 Naver Series 不在本适配器范围。
- 无新增第三方解析、解码或模型依赖；图标是随包绘制的 N 字母站点标识。

## 验证

从插件目录执行 `npm run check`、`npm test`、`npm run build`。定向回归：

```powershell
npm test -- src/sources/sites/naver/tests/network.test.ts tests/optional-source-content.test.ts tests/source-import-navigation.test.ts
```

真实扩展验收从仓库根目录执行，沿用[公共浏览器环境](../../../../../../scripts/README.md#来源与阅读验收)的 `PLAYWRIGHT_MODULE` / `TEST_CHROMIUM`：

```powershell
node apps/extension/src/sources/sites/naver/tests/verify-browser.mjs
node apps/extension/src/sources/sites/naver/tests/verify-import-navigation.mjs
```

`verify-browser.mjs` 新建隔离 profile 和构建产物副本，预授予本站权限，仅读取公开作品，不读取用户浏览器账号，不调用翻译模型。截图与脱敏结果存入被忽略的 `artifacts/naver-validation/`。

`verify-import-navigation.mjs` 使用隔离的合成网页、目录与随包样图，拦截外部网络，不访问真实 Naver。覆盖从首页 `pushState` 到作品页后首次点击、直接进入目录、图片解码、重开阅读与目录失败后的再次导入；结果与截图存入 `artifacts/naver-import-navigation/`。

2026-09-24：在 Chromium 扩展中复现并修复首页站内跳转后的首次点击失败。Chrome 的消息 `sender.url` 仍是原始首页，而 `tabs.get` 已是作品页；公共导入入口改为验证发送方来源与当前标签页同源，再按当前页面判定导入能力。上述合成页面浏览器回归通过；本次未重验真实网站网络协议或原生授权弹窗。

2026-09-23 实测：正式 Webtoon 样本 `758037` 的目录为 266 条，第一话清单为 137 张；通过真实嵌入按钮导入，关闭源站后读图、跳至第 10 页、回书架重开恢复通过，实际目录调度刷新通过；阅读与刷新新增源站标签页为 0。阅读页按钮复用同一本漫画，未重复创建。`bestChallenge/851953`、`challenge/842677` 的目录与首话清单分别为 5 条／12 张、6 条／4 张。正式 Webtoon 样本完整阅读器流程已验，两个投稿样本验到真实清单解析，未逐页解码全部图片。

回归还覆盖伪造主机、重复参数、跨作品／话、分页缺失和变化、重复页 URL、取消、失败保留旧目录、重复更新不累计提示，以及权限授予／撤销后的脚本登记。原生浏览器权限弹窗、账号受限内容、真实翻译效果、Firefox 现场运行未验；不以预授权样本替代这些验收。
