# GoodToon

支持 [www.goodtoon008.com](https://www.goodtoon008.com/) 的 `/manga/gt-<作品ID>/` 和其章节地址：韩文名称搜索、完整 AJAX 目录、原文正文／封面、12 小时同步、源站浮动导入与轻量作品名交接。标签页原位识图沿用通用规则，阅读方向从左向右。目录和阅读无需保留源站标签页。

## 协议边界

- 作品／章节精确认领 HTTPS 主机；`gt-ID` 和章节路径构成稳定身份。仅接纳源站首话／最新话按钮已核验的 `1권/<章节>` 同章节别名及 `?style=list`。旧域、任意镜像、分组或其他卷路径不推断等价。
- 目录一次详情 GET、一次作品 `/ajax/chapters/` 空表单 POST。校验 canonical、`postid-ID`、目录 holder、专用标题与封面所属作品，再复用 [Madara](../../shared/madara/README.md) 的完整平铺列表解析；剔除明确 `UP` 更新徽标，反转源站倒序列表，保留源站章节标签和 ID。不逐章拉取，不提交浏览量或解锁请求。
- 正文一次 GET，核对章节 canonical、所属作品、`chapter-select-nav` 当前项、章节标题和隐藏当前章标识；`reading-content` 直属图片按连续 `image-N` 保留页槽，包括重复 URL。只剔除源站末尾已确认的 `gt-reader-ad` 广告，不将未知图片、canvas、缺页或乱序视为完整正文。图片路径必须属于当前 `gt-ID`；不执行懒加载、备用图或广告脚本。
- 名称搜索每页一次 `/?q=<名称>[&pg=<页码>]` GET。使用源站 63 条固定分页，声明 `searchPageSize: 63`，不截断到默认 50 条、不重复请求同页、不预抓详情或全站作品库。下一页严格绑定查询、来源与连续页码；空结果须有完整空卡片容器。封面仍按可见区域加载，公共 3 并发、超时和响应预算不变。
- 当前 DOM 仅从与 canonical／所属作品链接一致的 `reader-title-manga` 读取作品名，不借用章节标题、不为查名请求目录。非公开、登录或验证失败直接报错，不回退通道。

## 分类与来源

[首页](https://www.goodtoon008.com/)明确标为“무료 웹툰”（免费网漫），按 Naver、Kakao、Ridi 等平台展示作品；公开目录和正文可匿名阅读，因此标为免费、韩漫／条漫。目录主要为韩文原作，包括 [GO라니의 독립일기](https://www.goodtoon008.com/manga/gt-21580/) 和 [나노마신](https://www.goodtoon008.com/manga/gt-16663/)，据整体目录与原文正文判断为生肉，非仅按界面语言；不保证所有作品都是原作，也不承诺源站永久免费。当前没有确认漫画阅读登录门槛，不把收藏登录要求当作阅读条件。

协议参考 [Keiyoushi GoodToon](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/ko/goodtoon) 和真实原始响应；固定提交、文件摘要与 Apache-2.0 许可见[上游记录](../../shared/madara/upstream.json)。上游旧配置域已迁移，只登记实际核验的新域；不执行／打包 Kotlin、APK 或源站脚本。图标为项目绘制。

## 验证

在仓库根运行，真实浏览器需先构建，并按[共享验收入口](../../shared/madara/README.md#验证入口)设置 `PLAYWRIGHT_MODULE` 和 `TEST_CHROMIUM`：

```powershell
npm --prefix apps/extension test -- src/sources/sites/goodtoon src/sources/shared/madara tests/source-search.test.ts --maxWorkers=2
node apps/extension/src/sources/sites/goodtoon/tests/verify-http.mjs
node apps/extension/src/sources/shared/madara/tests/verify-live-browser.mjs goodtoon https://www.goodtoon008.com/manga/gt-21580/ https://www.goodtoon008.com/manga/gt-21580/2/ --max-pages=80 --source-entry
node apps/extension/src/sources/shared/madara/tests/verify-search-browser.mjs goodtoon 회귀 NodeLaneNoSuchWork12973 --max-pages=2 --html-search --page-size=63 --query-param=q --page-param=pg
```

夹具覆盖严格身份、别名、跨作品／不完整目录、重复图片、页槽缺失、尾部广告、分页／取消和保留原快照。HTTP 验证真实两页搜索、空结果、完整目录、两章首尾图片／封面字节与另一作品的别名正文；浏览器验证浮动导入、真实解码、两章位置、关闭重开、两次同步和无效链接恢复，搜索验证真实“加载更多”、封面和书架零写入。产物仅写忽略的 `artifacts/goodtoon-http/`、`artifacts/madara-live-browser/` 和 `artifacts/madara-search-browser/`；结果以脚本实际报告为准。未调用翻译模型，不代表全站、所有图片、实机移动端或撤权验收。
