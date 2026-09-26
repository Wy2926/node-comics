# NAVER Webtoon

支持 `https://comic.naver.com/` 的 `webtoon`、`bestChallenge`、`challenge`：`list?titleId=...` 与 `detail?titleId=...&no=...`。提供 HTTP 导入、完整公开目录、12 小时更新、封面和原位翻译。

作品页可作为跨语言查找起点：`describeWork` 核对移动版 canonical 的分类／作品ID，再读取 `og:title`；章节页没有可靠作品名则手填。

名称搜索由 `search.ts` 读取 `/api/search/webtoon`、`/api/search/bestChallenge`、`/api/search/challenge`，按[源站](https://comic.naver.com/search)客户端方式预编码 `keyword` 再序列化查询。一次操作各取一页，每栏 10 条；游标只携带下一页及未结束栏目，最多返回 30 个候选。核对栏目、作品 ID、总数和页码，不混入 Naver Series 漫画或小说，不读取候选目录、不推断内容语言。任一请求失败或取消时不发布部分结果。

## 实现约定

- 作品信息使用 `/api/article/list/info`，目录使用 `/api/article/list` 的 ASC 分页；核对分类、作品、页码、总数和唯一话 ID，结束后复查第一页。分类分别命名空间，不推断晋级后的来源等价。
- 阅读页只解析唯一 `.wt_viewer` 内连续编号的 `content_image_N`；核对当前话与图片归属，保留重复 URL 的独立页槽。
- 图片仅来自 `image-comic.pstatic.net`，使用 Naver Referer；封面优先 `posterThumbnailUrl`，其次 `thumbnailUrl`。网络读取不携带账号 Cookie。
- 原位翻译只认领已加载正文切片，懒加载与换图重新识别；目录、年龄提示、广告和推荐不回退通用扫描。
- 目录、更新与取图不创建来源采集标签页。付费预览、登录／年龄／地区限制、移动站与 Naver Series 不在公开读取范围。

公共权限、入口和完整性规则见[适配规范](../../../../../../docs/SITE_ADAPTERS.md)。

## 验证

构建并配置[浏览器环境](../../../../../../scripts/README.md#来源与阅读验收)，从仓库根目录运行：

```powershell
node apps/extension/src/sources/sites/naver/tests/verify-browser.mjs
node apps/extension/src/sources/sites/naver/tests/verify-import-navigation.mjs
node apps/extension/src/sources/sites/naver/tests/verify-search-http.mjs
```

`verify-browser.mjs` 访问公开作品；`verify-import-navigation.mjs` 使用合成页面检查 SPA 首次导入、失败与恢复。原位回归设置 `INLINE_SITE_ONLY=naver` 后运行 `verify_inline_translation.mjs`。隔离配置与模拟译图不代替浏览器安装权限、撤权恢复、受限内容或模型效果验收。

`verify-search-http.mjs` 检查真实三栏目搜索、空结果及仅剩栏目翻页，报告在 `artifacts/naver/search-http/`；不涉及目录导入、浏览器安装权限或名称模型。
