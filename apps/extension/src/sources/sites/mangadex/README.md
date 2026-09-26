# MangaDex

支持 `https://mangadex.org/title/<manga UUID>[/slug]` 与 `https://mangadex.org/chapter/<chapter UUID>[/page]`。作品、完整分页目录、章节归属、专门封面及原始图片清单均读取公开 HTTP API；12 小时目录同步不打开源站标签页。原位图片翻译未声明支持。

一部作品使用一个漫画身份，各语言共用目录；一个章节 UUID 对应一个独立发布条目及阅读进度。章节 `translatedLanguage` 转为内容语言，作品 `originalLanguage` 不代替它。`es-la` 映射 `es-419`，`zh-hk` 映射 `zh-HK`，`zh` 映射 `zh-Hans`，罗马化日文／韩文／中文分别映射 `ja-Latn`／`ko-Latn`／`zh-Latn`。

完整 feed 保留各语言、外链和不可用条目，不使用语言筛选。`includeEmptyPages`、`includeExternalUrl` 等三态筛选必须省略：传 `1` 会仅取对应子集。每页核对总数、偏移、数量及 UUID，聚合目录中的 UUID 再与 feed 的作品、卷、话核对；数量或归属不一致使刷新失败，交公共层保留旧目录。

只有 `/aggregate` 明确聚合且 feed 卷话一致的编号章节共享 `readingSlotId`，同一位置各条目顺序相同，候选保留 feed 顺序；编号章节声明作品内跨语言的逻辑连读序列。标题只保留卷、话和源标题，翻译组独立放在 `rawTypes`，外链、不可用及空页条目标记 `readable: false`。公共层将同话合并显示，并逐话按目标语言、英语、源顺序选择可读条目；手动选择优先，具体规则见[单来源阅读](../../../../../../docs/SIMPLE_COMIC_READING_DESIGN.md#网站与只读目录)。无话号以及未获聚合证明的条目独立保留、独立阅读，不从标题推断对应关系。卷话数值和小数按升序排列，后缀保持源站语义，无话号排在同卷编号章节之后。

原始图片由 `/at-home/server/<chapter UUID>` 的 `data` 数组决定页序，保留重复文件在不同页槽。目录中的章节页数与返回清单必须相等。每页 `contentKey` 使用章节 UUID、图片 hash 和文件名；临时图片节点变更不改变内容身份。只接受 HTTPS `uploads.mangadex.org` 与单层 `*.mangadex.network` 节点，不固定猜测服务器或使用 `dataSaver` 替代原图。外链、不可用及空页发布条目在打开时明确报错，不替换其他发布条目。

网站访问遵循[公共权限规则](../../../../../../docs/SITE_ADAPTERS.md#必须保持的约束)，不逐站申请。具备浏览器访问权限的网页会挂载一个页面级导入／管理入口，使用自有固定位置容器并随导航／销毁清理；该入口不依赖 MangaDex 的专属 DOM 选择器。真实页面布局与 SPA 中入口可见性须在源站网页单独验收，隔离页面测试不能替代。

搜索只用公开 `/manga` 列表的 `title` 查询，每页 12 项，按相关度排序；不发送 `availableTranslatedLanguage[]`、`originalLanguage[]` 等语言筛选。结果有 `availableTranslatedLanguages` 时将其规范化为可选语言标签，缺失时不补齐；原作语言或书名语言不代替本站章节语言，也不影响作品是否返回。搜索采用 API 默认内容分级范围（`safe`、`suggestive`、`erotica`），源站分页上限为 10000 项。

网页种子要求作品页 `og:url` 与当前作品身份一致，再读取 `og:title` 的已知站点后缀；SPA 残留旧身份或章节页没有可靠作品名时不返回种子。OpenGraph 分享图不冒充作品封面。

协议来源：[MangaDex OpenAPI](https://api.mangadex.org/docs/static/api.yaml)、[公开 API 文档](https://api.mangadex.org/docs/)。本地图标为项目自绘的书本标识，不包含下载的第三方图标。没有使用源站脚本、账号令牌或 Cookie 转发。

验证入口：

```powershell
# apps/extension 下运行：隔离 API 与页面生命周期样本
npx vitest run src/sources/sites/mangadex/tests/network.test.ts src/sources/sites/mangadex/tests/page.test.ts

# 仓库根目录：真实公开 API、章节归属、英文/繁体中文页数及首图传输
node apps/extension/src/sources/sites/mangadex/tests/verify-http.mjs
node apps/extension/src/sources/sites/mangadex/tests/verify-search-http.mjs

# 仓库根目录，先构建 Chrome MV3：隔离浏览器及合成 API/图片
node apps/extension/src/sources/sites/mangadex/tests/verify-reader.mjs

# 同一阅读器验收切换到真实 API；不访问 MangaDex 网页
$env:RUN_LIVE_MANGADEX = '1'
node apps/extension/src/sources/sites/mangadex/tests/verify-reader.mjs
```

浏览器脚本使用 `PLAYWRIGHT_MODULE`／`TEST_CHROMIUM` 指定已有环境，产物写入忽略的 `artifacts/mangadex/`。HTTP 探针只证明协议和图片传输；浏览器脚本使用隔离配置，不能证明浏览器安装权限、撤权恢复或真实源站页面。均不调用翻译模型，不能证明翻译效果。

搜索 HTTP 探针独立验证名称命中、分页和空结果，报告在 `artifacts/mangadex/search-http/`；`search.test.ts` 覆盖查询编码、无语言过滤、可选内容语言、身份、取消和作品种子。搜索 HTTP 结果不代表浏览器权限、搜索 UI 或导入已通过验收。
