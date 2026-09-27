# 包子漫画（简体站）

支持 `https://cn.baozimh.com/comic/<作品 ID>`、本站 `/user/page_direct?comic_id=…&section_slot=…&chapter_slot=…` 章节入口，以及源站实际使用的 `https://cn.twbzmg.com/comic/chapter/<作品 ID>/<分区>_<章节>[_<续页>].html`。作品、章节和续页链接导入同一份完整目录；续页不另建章节。

本目录提供名称搜索、完整目录、正文与封面、12 小时目录同步、网页导入／管理入口和已加载正文的原位翻译。繁体站及未经验证的镜像不在认领范围。

## 来源协议

- 搜索读取 `/search?q=` 的完整候选列表，核对查询与结果计数，返回标题、作者和可用封面。源站缺少图片或使用 `unknown`／默认封面时保留作品，封面留空；目录导入遵循同一规则。封面归属以搜索卡片或作品详情的专用封面位置为准，校验封面 CDN 与路径，不要求文件名等于作品 ID。每次展示最多 50 项，游标绑定查询及完整结果摘要；源站结果变化后需重新搜索。源站使用模糊搜索，陌生查询也可能返回候选；未提供的最新话和内容语言不推断。
- 长目录读取 `chapter-items` 和隐藏的 `chapters_other_list`，与“查看全部 N 章节”交叉核对；不超过 24 章时源站只输出完整的“最新章节”列表，按其倒序还原阅读顺序。保留章节／整卷原始标题，不按名称重排或推断分类。只有同一源站分区共享连读范围。
- 章节入口与阅读地址使用相同作品、分区、章节身份，HTTP 正文直接请求阅读地址，避开跳转型入口。每次校验 canonical 和返回目录链接；源站屏蔽、缺失或不完整目录明确失败，不覆盖旧目录。
- 正文来自闭合的 `.comic-contain` 中的 `amp-img.comic-contain__item`。根据标题 `(当前页/总页数)` 和 `next-chapter` 顺序读取全部续页，逐页核对作品与章节，拒绝断链、循环、跨章续页和中途变化。源站续页可能重叠上一页末尾的图片，按源站顺序保留独立页槽，不按 URL 去重。广告、推荐封面和 `noscript` 副本不计入正文。
- 原图使用源页声明的 `bzcdn.net` 图片地址，经公共权限与 Referer 管线读取；无需图片解码。源站可能复用其他路径下的图片，作品归属以章节 canonical、目录链接和正文容器为准，不从 CDN 文件名推断。网页原位翻译仅选择 AMP 已加载的实际 `img`，懒加载、失败、导航和恢复由页面会话及公共运行时处理。
- 协议依据为[简体站](https://cn.baozimh.com/)的服务端 HTML 和其实际章节导航，不执行或打包下载的源站脚本。图标为自制图形。

源站可能对没有验证会话的 HTTP 请求返回 403。此时先在同一浏览器打开简体站并完成源站验证，再重试搜索或导入；后续读取无需保留标签页。适配器不绕过验证、不上传 Cookie，也不把验证失败当作空搜索或完整目录。站点入口语言仅为展示元数据，不据此给每个作品添加内容语言。

## 验证

在仓库根目录执行；Playwright 与 Chromium 环境变量见[脚本入口](../../../../../../scripts/README.md#来源与阅读验收)。

```powershell
npm --prefix apps/extension run check
npm --prefix apps/extension test
npm --prefix apps/extension run build
node apps/extension/src/sources/sites/baozimh/tests/verify-browser.mjs
$env:BAOZIMH_BROWSER_SESSION = '1'
node apps/extension/src/sources/sites/baozimh/tests/verify-http.mjs
$env:RUN_LIVE_BAOZIMH = '1'
node apps/extension/src/sources/sites/baozimh/tests/verify-browser.mjs
$env:INLINE_SITE_ONLY = 'baozimh'
node scripts/verify_inline_translation.mjs
Remove-Item Env:BAOZIMH_BROWSER_SESSION, Env:RUN_LIVE_BAOZIMH, Env:INLINE_SITE_ONLY
```

单元测试覆盖 URL 与资源归属、隐藏目录、分页、重复图片、取消、搜索游标和刷新失败保留。`verify-browser.mjs` 默认为隔离夹具，检查安装后的搜索、导入、取图、封面、重开位置、重复导入及更新；真实模式先正常访问首页建立源站会话，再关闭标签页读取。`verify-http.mjs` 检查真实搜索、完整目录、跨页整卷及图片字节，浏览器会话模式与无会话 HTTP 分开。原位脚本检查正文过滤、懒加载、恢复及导航失效；真实站点开关仍使用模拟翻译响应，不代表模型效果或浏览器原生权限对话框验收。截图与结果写入忽略的 `artifacts/`。
