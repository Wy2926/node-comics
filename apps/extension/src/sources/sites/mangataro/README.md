# MangaTaro

支持 `https://mangataro.org/manga/<slug>` 作品和 `/read/<slug>/ch<编号>-<发布 ID>` 章节链接。提供名称搜索、完整多语言目录、正文原图、作品封面、12 小时目录更新及作品／章节浮动导入入口。标签页识图显式声明 `inlineRecognition: 'generic'`，不添加专用 `page.ts` 或扩大通用扫描范围。

## 协议与边界

协议来自 [MangaTaro](https://mangataro.org/home) 公开作品页、阅读器与浏览页的请求结构；不复制或执行下载的脚本，不读取账户凭据。图标为项目自制字母标识。

- 作品身份使用带来源命名空间的 slug；章节使用独立发布 ID。小数章节的 URL 使用连字符（如 `ch19-5-13538` 对应 19.5），仍核对接口编号及正文所属作品，不能按标题去重。
- 作品 HTML 校验 canonical、body 与目录的作品 ID、专用封面元数据。`GET /auth/manga-chapters` 使用 `manga_id`、`offset`、`limit=500`、`order=ASC`，不加语言或发布组过滤。顺序请求至 `has_more=false`，每批校验 offset、limit、total 和实际数量；最多 10000 个条目。失败、重复发布、跨作品或读取途中总数变化均明确拒绝，不覆盖已有目录。
- 目录接口的公开时间校验值为 `MD5(Unix 秒 + mng_ch_ + UTC yyyyMMddHH)` 前 16 位，由本站代码生成；它不是用户 Cookie、登录令牌或秘密凭据。算法是本站短 ASCII 请求的单块 MD5 实现，不引入加密依赖或公共接口。
- 保留源站章节顺序、语言与发布组，同编号的独立发布共享阅读位置，仍保留各自 ID。源站 `text` 章节标为不可读，不将小说正文当成漫画图片。
- 正文先核对 HTML canonical、章节 ID／编号与 `#manga-info-link` 所属作品，再读取 `GET /auth/chapter-content?chapter_id=...`。仅接受成功的 `media` 列表及匹配的章节 ID、总页数，保留重复 URL 的独立页槽；不按图片文件名重排。403、不可用及空正文明确失败，无跨通道兜底。
- 搜索使用浏览页的 `POST /wp-json/manga/v1/load`，复用公共表单编码；仅传名称、页码和原站默认筛选，不抓取候选目录。游标绑定查询，沿用源站空页结束规则，不根据短页推断结束；小说候选不导入。不从站点主语言推断候选内容语言。
- 图片、权限、Referer、缓存与位置恢复由公共实现维护；无站点专用图片处理器。不预取整章图片，不调用翻译服务。

## 验证

仓库根目录执行：

```powershell
npm --prefix apps/extension run check
npm --prefix apps/extension test -- --run src/sources/sites/mangataro/tests tests/source-generic-inline.test.ts tests/source-architecture.test.ts tests/source-http-form.test.ts --maxWorkers=4
node apps/extension/src/sources/sites/mangataro/tests/verify-http.mjs
npm --prefix apps/extension run build
```

单测使用自建脱敏夹具，覆盖身份、500 条分页边界、总数变化、同话候选、空目录、拒绝访问、取消、失败保留及图片顺序。真实 HTTP 脚本对公开日漫／韩漫读取完整目录、普通／小数／非英语章节、封面及首尾原图，记录请求数、目录耗时、字节量与进程堆变化（不是峰值内存），不保存源站全文或图片；结果写入忽略的 `artifacts/mangataro/http/`。

源站浏览器呈现、已安装扩展的导入／续读／权限、通用原位模拟翻译和真实模型效果是不同验收范围；HTTP 与单测不能替代后者。
