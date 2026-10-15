# Madara 共享引擎

在浏览器前端执行的 TypeScript HTML 解析器与只读请求编排。实现复用项目已有代码，并参考 [Keiyoushi extensions-source](https://github.com/keiyoushi/extensions-source) 的 Madara 协议；不运行、加载或打包 Kotlin／APK，也不是上游全部 Madara 功能的移植。

当前显式接入 WebtoonScan、LHTranslation、Mangasushi 和 Manga Eclipse，来源注册为 `sites/` 下的 37 个适配器。固定上游版本中的 249 个 Madara 源模块是参考范围，不代表其余网站已经注册、适配或验证可用。

## 接入与职责

站点提供 [MadaraSite](config.ts) 所需的来源身份、地址识别与构造、阅读方向和图片地址校验器。域名、稳定 ID、图片策略、普通 HTTP／网页会话选择、安装入口和原位识图仍归站点及公共运行时；引擎不声明具体主机、不注册站点、不认领未知网页。

- [createMadaraParsers](index.ts) 是纯解析入口：接收原始 HTTP 响应，返回搜索、目录和正文结果，不请求网络。不能用执行源站脚本后的 DOM 快照代替原始响应，脚本可能删除或改写身份字段。
- [createMadaraNetwork](network.ts) 复用同一解析器，仅通过调用方的 `context.request` 执行声明的 GET／只读表单 POST，并在请求前后检查取消。没有直接 `fetch`、浏览器 API、隐藏请求通道、缓存或失败后自动切换。
- [madaraImageUrl](image.ts) 提供共享地址语法检查；实际图片权限、Referer、字节读取和解码沿用公共图片管线。

当前经过站点声明的协议组合如下；未填 `searchPageSize` 时不生成 `network.search`，也不能在站点元数据中声明名称搜索。

| 消费站点 | 目录 | 正文身份协议 | 名称搜索 |
| --- | --- | --- | --- |
| [WebtoonScan](../../sites/webtoonscan/README.md) | 静态列表 | 章节 canonical、标题与静态选择框 | 公开 HTML，20 项分页 |
| [LHTranslation](../../sites/lhtranslation/README.md) | `catalog: 'ajax'` | `reader: 'ajax-select'` | `search: 'ajax'`，12 项分页 |
| [Mangasushi](../../sites/mangasushi/README.md) | `catalog: 'ajax'` | `reader: 'ajax-select'` | `search: 'ajax'`，12 项分页 |
| [Manga Eclipse](../../sites/mangaeclipse/README.md) | 静态列表 | `reader: 'catalog-select'` | `search: 'ajax'`，12 项分页 |

## 已实现的协议边界

- **作品与目录**：作品 canonical 必须精确匹配；标题仅去除已确认的 `manga-title-badges`，封面必须属于该作品。静态目录接受单一 `listing-chapters_wrap` 内未分组的 `ul.main.no-volumn` 或 `ul.main.version-chap`，包含已在 HTML 中的折叠行。拒绝 `has-volumn`、嵌套／额外列表、未知行和额外链接。
- **只读 AJAX 目录**：先核对详情页的 canonical、`body.postid-*` 与 `manga-chapters-holder[data-id]`，再向该作品 `/ajax/chapters/` 发送一次空表单 POST；不逐章抓取、不轮询、不执行源站脚本。响应仍须满足完整平铺列表规则，列表外只允许已确认的本地排序链接；分页、动态加载按钮或额外链接拒绝读取，不把部分响应声明为完整目录。下载按钮只有在作品数字 ID、章节数字 ID 和占位链接符合协议时才作为辅助标记忽略，不触发下载。
- **目录顺序与完整性**：最多 10000 行，反转源站倒序列表形成阅读顺序。相同章节与标题去重；冲突标题、跨作品条目或错误更新标记拒绝读取，不推断缺失章节或跨组连读。
- **列表正文**：默认要求章节 canonical、`h1#chapter-heading` 和静态章节选择框。`ajax-select` 保留章节 canonical／标题，改为核对作品数字 ID、顶部导航以及两份 AJAX 选择占位标记；不额外请求选择框。`catalog-select` 要求 canonical 精确指向所属作品，使用全部已验证静态选择框的一致选中项文字作为章节标题。所有模式都核对正文当前章节标识；选中项存在时，其章节值、完整地址与文字必须一致。
- **图片页槽**：仅接受 `reading-content` 内 `page-break` 与连续的 `image-N`，最多 1500 页。保留重复 URL，不补页、不重编号，不把视频、画布、额外图片或缺失槽当作完整正文。封面支持 `data-lazy-src`／`data-src` 并忽略 `noscript` 备用图；正文使用 `data-src`／`src`，全部地址经站点提供的校验器处理。
- **公开 HTML 名称搜索**：默认使用 `?s=<query>&post_type=wp-manga` 与 `/page/<n>/`，核对查询、结果总数、已验证页大小和同源下一页，保持 WebtoonScan 的既有协议。
- **AJAX 名称搜索**：`search: 'ajax'` 从第一页直接向 `/wp-admin/admin-ajax.php` 发送只读 `madara_load_more` 表单；固定 `content-search` 模板、已发布漫画类型、站点声明的页大小、名称与零基页码。每页仅一次 POST，无初始化 GET、不执行源站脚本、不转发整包页面参数、不预取候选详情。与 HTML 搜索共用作品／封面解析和来源校验。只接受完整卡片片段；单一空的末尾 `no-posts` 标记确认结束（也可用于满页），无标记的满页保留下一游标，非空短页缺少标记则报错，防止在卡片边界截断后漏项。成功空正文是已验证的无结果信号，WordPress `0`、错误／验证页及未知结构不能变成无结果。AJAX 响应没有总数，不套用公开 GET 页面可能不同的总数与默认页大小。公共运行时继续绑定会话／站点／名称游标、超时、取消和访问权限，不自动读取所有页。

其余 AJAX 目录变体、分卷／分组、archive 搜索模板及高级筛选、RSS、post-ID 补查、自定义阅读包装、保护脚本与加密正文不在当前范围。新增实际消费站点时先核对原始响应和完整性证据，再实现已确认的差异；不预设配置或宽松兜底，也不因上游继承同一基类就自动开放能力。

## 来源与许可

上游版本、参考文件、SHA-256 和用途集中在 [upstream.json](upstream.json)。上游采用 Apache-2.0；[随包来源声明与许可证全文](../../../../public/licenses/keiyoushi-extensions-source.txt) 保留其许可，固定版本未包含仓库级 `NOTICE`。上游只作协议参考，本项目的严格归属、完整性与图片策略以当前实现为准。

## 验证入口

在 `apps/extension` 执行：

```powershell
npm test -- src/sources/shared/madara src/sources/sites/webtoonscan src/sources/sites/lhtranslation src/sources/sites/mangasushi src/sources/sites/mangaeclipse --maxWorkers=2
```

共享和站点自造夹具检查来源隔离、协议组合、取消、请求数量、完整性、错误归属与页槽边界。真实 HTTP、原始响应回放、浏览器导入与原位入口的条件以各站 README 为准；回放已采集 HTML 不代表当前在线状态，解析通过不代替真实图片解码、浏览器阅读／位置恢复和模型验收。

构建 Chrome MV3 后，在仓库根执行共享的真实浏览器验收（需要 `PLAYWRIGHT_MODULE` 与 `TEST_CHROMIUM`）：

```powershell
node apps/extension/src/sources/shared/madara/tests/verify-live-browser.mjs <siteId> <作品或章节URL> [同作品第二章URL]
```

脚本使用隔离 profile 和正式产品链接导入入口，不改写源站响应、不注入目录／图片／阅读位置；校验最多两章、实际图片与封面解码、小窗口阅读、关闭重开位置及两次目录刷新幂等。默认每章最多 40 页，限制总请求、图片响应、流量和运行时长，超过预算即失败；仅阻断产品账号／模型服务。报告和截图存入忽略的 `artifacts/madara-live-browser/`。这是桌面浏览器验收，不代表实机移动端、撤权恢复、原位翻译或真实模型效果。

AJAX 搜索同样使用隔离 profile 和正式产品界面，需先构建并配置上述浏览器环境变量：

```powershell
node apps/extension/src/sources/shared/madara/tests/verify-search-browser.mjs lhtranslation a NodeLaneNoSuchTitle987654 --max-pages=10
node apps/extension/src/sources/shared/madara/tests/verify-search-browser.mjs mangasushi a NodeLaneNoSuchTitle987654 --max-pages=5
node apps/extension/src/sources/shared/madara/tests/verify-search-browser.mjs mangaeclipse a NodeLaneNoSuchTitle987654 --max-pages=3
```

每次只勾选指定站点，实际提交名称、点击「加载更多」直至末页，再重新搜索不存在名称；检查每页唯一 POST、查询和零基页码、来源归属、跨页不重复、顺序保留、终点按钮消失和真实封面解码，并断言没有读取候选详情或写入书架／目录。页数是验收上限而非固定源站结果，超限即失败，不自动扩展扫描；默认最多 3 页，显式配置最多 10 页，另限 90 请求、18 张封面响应、32 MiB 和 180 秒。只阻断产品账号／模型服务，不替换源站响应、不改 UA 或导入用户 Cookie。报告和截图写入忽略的 `artifacts/madara-search-browser/`；这是实际桌面无头扩展 UI 与真实服务验证，不是用户现有浏览器、移动端或模型验收。

在仓库根执行 `node apps/extension/src/sources/shared/madara/tests/verify-performance.mjs <基准提交>`，对比基准与当前 WebtoonScan 路径的 1000 章目录、100 页正文和 20 条搜索结果。脚本核对输出及单次请求数量，记录解析耗时和独立网络入口打包体积，产物保存在忽略的 `artifacts/madara-performance/`。这是自制 HTML 的离线对比，不代表 AJAX 网络时延、浏览器渲染、整包体积、图片解码或模型效果。
