# RawKuro / Raw1001

两个入口共用 `rawkuro` 来源和作品／章节身份：`https://rawkuro.net/`、`https://raw1001.net/`。相同作品的 slug、章节 slug、`MANGA_ID`、`CHAPTER_ID` 及正文列表一致；请求保留用户选定的域名，不在失败时自动切换镜像。

## 支持范围

- `/manga/<slug>` 作品和 `/manga/<slug>/<chapter>` 章节导入；章节包含分话等不透明后缀。网页显示公共浮动导入入口。
- 名称搜索 `/search/?keyword=…` 与 `/search/<page>/?keyword=…`，只读取结果卡片和分页，不为搜索抓取目录。
- HTTP 静态完整目录 `#myUL > li.chapter`、专门作品封面、12 小时目录同步。按源站“下一章”顺序反转最新在前的目录，不按数字猜测顺序。
- 正文先读取章节页并核对 canonical、作品链接及章节选择器，再从脚本文本提取字面量 `CHAPTER_ID`，向同域 `/ajax/image/list/chap/<id>` 发起空表单只读 POST。每章两次清单请求，无逐页清单请求。
- 正文接口一次返回完整列表，按 `.separator[data-index]` 的连续零基索引恢复顺序；保留重复图片 URL 的不同页槽，拒绝重复索引、缺页或无效原图定位。没有索引的源站推广图不进入正文。不执行下载的脚本。
- 正文取图沿用源站 `no-referrer`，不代理上传 Cookie，不实现图像解码或图片服务器自动切换。
- 标签页翻译声明 `inlineRecognition: 'generic'`，复用已加载大图及懒加载观察；没有专用 `page.ts`，不改变通用识别。

协议依据为两站公开作品 HTML、章节 HTML、搜索分页和正文 POST 响应。站点展示以日语原文日漫为主；两个入口收费类型均为 `free`，依据 [RawKuro](https://rawkuro.net/home) 与 [Raw1001](https://raw1001.net/home) 的免费漫画说明、公开作品目录及现有章节正文开放流程综合判断，未见章节购买或会员解锁要求；账号入口本身不作为阅读收费依据。图标为本地绘制的字母标记，无第三方图标依赖。

## 验证入口

在 `apps/extension` 执行 `npx vitest run src/sources/sites/rawkuro/tests/network.test.ts`，覆盖镜像身份、URL／归属拒绝、目录、索引页序、搜索分页、取消与失败保留；并执行 `npm run check`、`npm test`、`npm run build`。

仓库根目录：

```powershell
node apps/extension/src/sources/sites/rawkuro/tests/verify-browser.mjs
$env:INLINE_SITE_ONLY = 'rawkuro'
node scripts/verify_inline_translation.mjs
```

- 浏览器工具加载已构建 MV3，检查两个入口的真实搜索和封面、章节导入、逐页解码、重开恢复、无源站标签页同步、模拟失败保留、镜像链接重复导入。使用隔离 profile；支持 `PLAYWRIGHT_MODULE`、`TEST_CHROMIUM`／`CHROMIUM_PATH`、`TEST_EXTENSION_DIR` 及 `RAWKURO_READER_URL`。公网可用性单独记录，不把源站错误当成解析成功，不调用翻译模型。
- `tests/verify-inline.mjs` 由公共原位脚本发现，使用合成 DOM／图片和模拟翻译接口，覆盖两域名的通用识别接入、缩略图排除、懒加载、原图恢复、几何保持与导航清理。通用长图、滚动与像素管线由公共回归覆盖，不在本站复制测试，不证明真实模型效果。

结果与截图写入忽略的 `artifacts/`；不向仓库保存源站全文或漫画图片。通用环境见[脚本入口](../../../../../../scripts/README.md)。
