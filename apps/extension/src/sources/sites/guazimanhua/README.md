# 瓜子漫画

- 作品：`https://www.guazimanhua.com/comic.php?id=<作品 ID>`。
- 章节：`https://www.guazimanhua.com/chapter.php?id=<章节 ID>`。
- HTTP 读取完整目录、正文页清单与专门封面；每 12 小时通过公共调度更新目录。具备浏览器网站访问权限时在作品页、章节页嵌入 `NodeLane Comics · 导入/管理漫画`。导入、阅读、目录同步不创建来源采集标签页。
- 章节 URL 不含作品 ID。弹窗、章节页按钮和粘贴链接统一通过 `Article.isPartOf` 解析作品，再核对完整目录包含当前章节。目录内链接以 `#nodelane-guazimanhua=<作品 ID>` 保存本地绑定，片段不发送到源站；取图时再次校验作品与章节归属。归属解析的章节 HTML 可通过公共短期会话交接复用，不重复请求。
- 使用服务器输出的 `.all-chapter-grid`，将源站倒序目录转为阅读顺序，不按章节 ID 数值排序。读取数量必须等于源站章节总数，重复、截断或失败响应不能替换已接受目录。
- 正文取自 `.reader-images`，按 `data-page` 和 `page-N` 核对页序及总数。JSON-LD `ItemList` 只列前 20 张，`numberOfItems` 是全章数量；逐项核对前 20 张后读取完整正文，不能把 SEO 预览当成全章。远程脚本仅作为 JSON 数据解析，不执行。
- 封面来自已验证作品的 `ComicStory.image`，不从推荐或正文图片选取。`img.guazicdn.com` 与 `api.guaziapp.com` 使用插件统一的网站访问权限，图片经过公共 HTTP 管线，无专用防盗链头或图片还原。
- 不声明网页原位翻译能力；章节正文采集完全通过 HTTP。源站未提供正文或结构不完整时明确失败，登录／付费限制以源站为准。
- 搜索使用首页表单公开的 `/category.php?keyword=<关键词>&page=<页码>`；交叉核对 `CollectionPage.mainEntity` 的结果列表和 `article.card`，只读取当前页，不跟随分类、地区或推荐链接。分页来自 `.pager`，必须保持同一关键词。结果未提供语言时不声明语言；搜索封面使用结果卡自有封面。
- 网页查找种子复用作品页 `ComicStory` 或章节 `Article.isPartOf`，核验当前页身份后取作品名，不把章节 `headline` 当作作品名。

## 验证

在 `apps/extension` 运行 `npm run check`、`npm test`、`npm run build`。

真实浏览器验收从仓库根目录执行，环境变量见[脚本入口](../../../../../../scripts/README.md)：

```powershell
node apps/extension/src/sources/sites/guazimanhua/tests/verify-browser.mjs
node apps/extension/src/sources/sites/guazimanhua/tests/verify-search-http.mjs
```

脚本使用隔离的 Chromium MV3 配置和公开漫画样本，不使用用户浏览器资料，不调用产品 API 或翻译模型。覆盖网站入口、裸章节弹窗导入、跨后台和阅读器的 HTML 复用、粘贴章节／作品链接、站内按钮重复导入、完整取图、书架封面、关闭来源页后的目录同步和重开页码。报告和截图位于被忽略的 `artifacts/guazimanhua/browser/`。浏览器安装权限与撤权恢复、Firefox 和登录／付费章节不在此验收范围。

`search.test.ts` 使用合成搜索页覆盖 JSON-LD／可见列表一致性、空结果、归属、分页及取消；搜索 HTTP 探针独立验证实时前两页和无结果查询，报告写入忽略的 `artifacts/guazimanhua/search-http/`，不验证浏览器安装权限与撤权恢复、搜索 UI、导入或名称模型。
