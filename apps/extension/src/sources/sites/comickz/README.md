# ComicK (comickz)

默认入口：[comickz.co.uk/home](https://comickz.co.uk/home)。只认领此域名，不声明其他 ComicK 域名为等价镜像。

## 支持范围与协议

- 作品 `/comic/<slug>`；章节 `/comic/<slug>/<hid>-chapter-<话号>-<语言>`。作品身份使用本站 slug，章节身份使用源站 hid；导入时保留作品归属，未知路径不可导入。
- HTTP 名称搜索、分页只读多语言目录、完整章节图片清单、专用封面、12 小时目录同步及网页浮动导入入口。标签页翻译显式沿用公共通用图片识别，不新增 `page.ts` 或站点图片启发式。
- 作品 HTML 的 `application/json#comic-data` 提供标题、slug、封面和章节总数。`/api/comics/<slug>/chapter-list?chapOrder=asc&page=N` 提供升序目录；省略语言条件表示全部语言，不能传 `lang=all`。核对每页总数、页码、页大小、完整数量和重复身份后才发布完整目录。
- 首次目录请求后最多三页并发，按源站分页顺序合并；不扫描其他作品或缓存独立目录状态。目录上限沿用公共 10000 条，失败不提交部分目录。
- 保留卷号、话号、发布组和实际语言。同卷同话的多语言／发布组共享阅读位置，保留独立发布 ID；无话号不合并，不猜测跨卷连读。入口 `en` 仅作主要语言展示，不过滤其他语言。
- 正文解析 `application/json#sv-data` 的 `chapter.images`，核对作品 slug、章节 hid、话号与语言。完整数组提供页序；重复图片仍是独立页槽，外链／空正文明确失败。只解析 JSON，不执行下载脚本。
- 图片及封面来自源站明确提供的 `cdn1.comicknew.pictures`、`cdn2.comicknew.pictures`。封面限定当前作品 `covers`；正文限定当前作品、卷／话号及语言。迁移路径中的 `1.0` 与目录 `1` 按数值一致核对，不改写原地址。权限、Referer、字节读取及失败重试沿用公共取图管线。
- `/api/search?q=...` 返回轻量候选；只按名称搜索，实际语言取 `lang_list`，不把作品原作语言当成译本语言。分页使用源站游标并绑定查询；游标最多保留前一页的 50 个数字 ID，过滤相邻重叠结果、在整页重复时停止，不尝试绕过源站分页故障。
- 不声明全站免费、登录或收费标签：部分样本的访问情况不能证明全站规则。

## 验证

仓库根目录执行：

```powershell
npm --prefix apps/extension test -- src/sources/sites/comickz/tests
npm --prefix apps/extension run check
npm --prefix apps/extension test -- --maxWorkers=4
npm --prefix apps/extension run build
node apps/extension/src/sources/sites/comickz/tests/verify-http.mjs
node apps/extension/src/sources/sites/comickz/tests/verify-browser.mjs
$env:INLINE_SITE_ONLY='comickz'; node scripts/verify_inline_translation.mjs
```

- 单元夹具覆盖来源／图片归属、分页完整性和有界并发、同话与语言、重复图片、更新失败、取消、搜索游标及重复页终止。
- HTTP 验证默认读取两部公开作品，覆盖长目录、多个语言、首末章节及抽样原图／封面；`COMICKZ_CATALOG_URL` 可限制作品。CDN 失败后停止继续取图，目录和清单检查继续，报告标记 partial 并非零退出，不将清单成功当成图片成功。
- 已安装 MV3 浏览器验证使用隔离 profile，覆盖名称搜索、网页章节入口、整章解码、关闭重开续读、无源站标签页更新、重复导入、封面，以及模拟 HTTP 失败后目录与位置保留。可指定 `COMICKZ_READER_URL`；使用 `PLAYWRIGHT_MODULE` 和 `TEST_CHROMIUM`／`CHROMIUM_PATH`。
- `COMICKZ_FIXTURE=1` 将该浏览器验证切换为隔离源站／CDN 夹具和合成图片，不访问真实服务，报告明确标注 `liveSource: false`；用于源站不可用时独立验证产品交互，不代替真实取图验收。
- 原位回归使用合成图片与模拟翻译，检查通用识别仍生效、懒加载、小图排除、原图恢复、位置保持和导航失效。使用公共脚本的 `PLAYWRIGHT_MODULE`／`CHROMIUM_PATH`。

产物写入忽略的 `artifacts/comickz/`、`artifacts/inline-validation/`。以上不调用真实翻译模型；真实 HTTP、已安装扩展阅读和模拟原位翻译分别验收。
