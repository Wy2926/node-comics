# 网站适配开发规范

新增或修复网站从本文开始。产品边界见[单来源阅读](SIMPLE_COMIC_READING_DESIGN.md)，类型以 [sources/contracts](../apps/extension/src/sources/contracts) 为准；站点规则和验证入口放在各站自己的 README，不复制公共契约。

## 最小目录与接入

在 `apps/extension/src/sources/sites/<id>/` 添加文件，注册表按统一通配约定静态收集，无需手工注册具体站点：

| 文件 | 职责 |
| --- | --- |
| `definition.ts`（必需） | 导出 `definition`：与目录名一致且唯一的稳定 ID、纯 URL 识别、能力、可选目录同步与网站入口元数据 |
| `installation.json`（必需） | 站点主机与内容脚本范围；由定义引用，供来源边界校验及内容脚本登记 |
| `page.ts`（按需） | 导出 `createPage`：DOM／canvas 会话、发现、显示目标、观察与清理；可选 `describeWork` 提供可靠作品名与定位 |
| `network.ts`（按需） | 导出 `network`：独立可选的 `catalog`、`pages`、`search` HTTP 解析操作；章节 URL 缺少作品身份时可提供 `resolveCatalog` |
| `image.ts`（按需） | 导出 `image`：图片请求头、正文解码或原位 HTTP 原图解码；不依赖是否实现网络目录 |
| `icon.svg`、`README.md`、`tests/` | 本地图标、支持范围与协议来源、脱敏夹具和站点测试 |

先检查真实站点的目录、页序、懒加载、图片与权限，再声明能力。选择 DOM、HTTP 或混合通道；纯网络站点不创建空 `page.ts`。公共接口缺少必要能力时修改契约及通用实现，不向核心添加站点分支。

## 必须保持的约束

1. **站点隔离。** 域名、路径、资源归属及站点特有选择器／协议只在本站目录；站点之间不互相导入。同一阅读器引擎经多个站点验证的结构、观察规则及解码算法可集中到 `shared/<engine>/`，由站点显式调用并传入身份／资源校验器（如 [GigaViewer](../apps/extension/src/sources/shared/gigaviewer/README.md)）；共享引擎不声明主机、不自行请求、不自动认领未知网站。其余复用无站点语义的 `shared/` 工具，不调用整个 `generic` 作隐式兜底。
2. **依赖方向。** 站点只依赖自身、`contracts/`、`shared/` 和现有 i18n；不调用 `chrome.*`／`browser.*`，不导入 UI、漫画仓储、缓存、翻译或来源运行时。`definition.ts` 的传递依赖不访问 DOM、浏览器全局或 CSS。
3. **公共入口。** UI、漫画应用与页面服务使用 `sources/index.ts`；内容脚本使用 `sources/page.ts`。公共层负责权限、网络、消息、标签页、清单登记和生命周期，注册表不得直接引用具体站点文件。
4. **明确认领。** 先校验 HTTP(S) URL，再精确核对主机、路径与资源归属。一个站点匹配才使用；冲突报错。未知站点仅用通用原位翻译，不能导入漫画。已认领站点等待、失败或能力缺失时不退回通用规则或另一读取通道。
5. **稳定身份与只读目录。** 身份包含来源命名空间，不按标题或临时 CDN 地址去重；保留必要的查询参数与片段，镜像等价须有证据。条目、分组、原始标签和可选阅读序列来自源站；不推断章节类型、正文归属或跨组连续阅读。目录更新只使用调用方给出的 `previous`，不另存已选上传状态。
6. **发现不等于取图。** 返回稳定页槽和来源顺序，重复 URL 可以是不同页；缺页不重编号。`ready / not-ready / unsupported / error` 与清单完整性分开；只有可靠总数、完整列表或单页契约能证明完整，canvas 窗口和暂时不增长不能。
7. **临时资源受控。** 站点给出 HTTP 地址或页面逻辑资源，公共层登记后才能读取。句柄绑定文档、导航、元素和版本，不能持久化为离线原图。导航、替换、画布重绘、取消与销毁后拒绝旧读取，清理观察器、挂载入口和译图；`pageshow` 重建会话而不复用旧句柄。
8. **权限与数据。** [WXT 配置](../apps/extension/wxt.config.ts)统一声明必需 `host_permissions`：`https://*/*`、`http://*/*`，不声明 `optional_host_permissions`，不逐站申请授权。站点仍在 `installation.json` 声明实际使用的主机；搜索 `requestOrigins` 是运行时网络允许范围，必须包含在本站主机声明内，不是授权清单。需嵌入网站入口时声明 `optionalContentMatches`，公共运行时检查浏览器当前访问权限后登记内容脚本，撤权后取消登记。网络读取继续检查实际访问权限；浏览器限制访问时提示在扩展设置中允许访问所有网站后重试。业务登录与 OAuth 同意独立保留。页面文字、HTML、URL 均不可信，不执行下载的源站脚本，不上传 Cookie／令牌，不记录私有图片、全文或签名地址。请求头与图片解码经公共取图接口处理，不直接修改全局网络规则。
9. **按能力开放。** 漫画导入须声明 `importable` 和页面能力；目录、原位翻译、完整页清单、自动同步分别声明并有实现。`catalogSync` 仅在能可靠读取完整目录时开放；调度、更新提示、缓存与阅读位置由公共应用层维护。网站入口使用 `sites` 元数据和随包图标；各入口必须在 `primaryLanguages` 中按展示顺序声明主要内容语言（BCP 47 数组），UI 据此显示多枚语言国旗，不加专属组件。该数组仅用于展示，不限制目录包含的语言。

搜索按具体 `SourceSite.search` 可选声明，并提供 `network.search`，共用现有静态注册。搜索只按名称查询，不依据 `primaryLanguages` 或候选语言过滤；网站实际提供的语言作为可选结果字段返回，缺失时不推断。查询返回轻量候选页而非目录，游标、权限与交互遵循[跨语言搜索](COMIC_SEARCH_DESIGN.md)。网页起点与可被搜索是两个独立能力；`describeWork` 不返回章节标题，也不为查名字抓完整目录。

网站入口由适配器声明首次适配日期 `adaptedOn`（`YYYY-MM-DD`），后续修复不改写；镜像入口按各自首次支持日期填写。已适配网站目录显示日期并按日期从新到旧排列，同日保留声明顺序。仅确认全站漫画可免费阅读时声明 `isFree: true`，目录据此在“已适配”旁显示“免费”标签，并提示“全站漫画免费阅读”；部分免费、付费或未确认的站点不显示。日期与标签均来自随包元数据，打开列表不额外请求源站。

各入口用 `contentTags` 概括主要漫画类型：日漫、韩漫、国漫、条漫或同人，依据源站实际目录选择，不能根据界面语言推断漫画产地。每站展示 1–3 个内容标签，免费状态独立展示；优先突出主要内容，不罗列全部分类。内容标签仅用于网站目录展示，不作为导入或搜索过滤条件。

缺少稳定网页挂载位置的站点可声明 `embeddedEntry: 'floating'`，由公共运行时在已识别的可导入页面显示浮动导入按钮。站点可通过 `capabilities.findAlternatives: false` 关闭“寻找其他语言”的网页、弹窗、书架与阅读器入口；未声明时保持现有行为。这与站点是否支持名称搜索独立。

多语言目录可提供条目的 `contentLanguage` 和 `readingSlotId`。前者是实际源内容的规范语言标签；后者是适配器依据源站明确关系给出的不透明阅读位置键，同位置候选使用相同顺序。`sequenceId` 声明安全的逻辑连读范围，可以包含同话的不同语言；同一位置的多个发布条目保留各自稳定 ID，公共层负责按话合并目录、逐话自动选择及独立进度。目录直接使用条目标题，发布组等说明通过已有 `rawTypes` 提供；源站明确标注外链、不可用或无正文时使用 `readable: false`，未提供表示没有目录层不可读证据。无可信对应关系时不共享位置；无位置键时每个条目独立。相同位置候选按完整快照中的稳定顺序选择，完整目录包含全部支持语言。目标语言、手动选择和续读属于本机应用数据，选择规则见[单来源阅读](SIMPLE_COMIC_READING_DESIGN.md#网站与只读目录)。

公共执行边界以 [resolve.ts](../apps/extension/src/sources/core/resolve.ts)、[catalog.ts](../apps/extension/src/sources/core/catalog.ts)、[resources.ts](../apps/extension/src/sources/core/resources.ts) 和 [runtime](../apps/extension/src/sources/runtime) 为准。HTTP 与 DOM 清单共用校验；`readSourceImage` 只向页面服务交付 Blob。精确图片 URL 的请求头由公共层以 Web Lock 隔离，完成或取消后释放。资源大小、超时和缓存预算不由站点绕过。

HTTP 页面可提供源站证明的 `contentKey`，用于内容不变而临时下载地址变化的场景；页槽 ID 与内容键保持一致时只刷新取图定位，不重置页身份和进度。打开或预载已完整索引的条目时复用已有清单，优先读取离线原图与普通阅读缓存；缺图先读取已登记地址，读取失败才合并同一章节清单的并发刷新，并重试取图一次。取消、权限不足或限流不触发自动刷新；发现失败保留原索引与缓存。内容键变化、消失或页槽变化仍需明确重新载入。未提供内容键的页面继续以 URL 与页槽判断变化；实际字节摘要始终由页面服务独立核验。页面绑定的临时资源不能声明此键。

弹窗、站内按钮和粘贴链接共用 `readImportCatalog`：目录型站点先确定作品身份，无作品绑定的章节清单不能直接建库。HTTP 目录入口将已校验来源 URL 交给阅读器执行，不在打开阅读器前等待完整目录。适配器可通过 `context.onCatalogProgress` 提供已确认条目的部分快照，公共层校验来源、身份、条目和组引用后保存；该快照及未完成组必须保持 `complete: false`。首批有可阅读条目即可按公共规则阅读，完整目录继续加载，`catalog()` 的最终返回仍必须通过完整性校验。现有适配器无需提供进度回调。

明确导入章节链接时，只在已确认快照含该发布条目后保存选择并打开；没有目标时继续等待，最终完整目录缺少指定章节则明确失败，不能替换成其他章节。导入作品链接保留已有续读选择，首次按公共规则直接阅读。URL 已含作品身份时继续使用纯 `identify`；缺少身份才调用可选 `resolveCatalog`，由本站 HTTP 解析器给出作品地址，公共层校验同一适配器及目录中的章节归属。归属解析、目录和正文读取独立选择能力：`resolveCatalog` 不要求实现 HTTP `catalog`，目录交给公共读取器选择 HTTP 或 DOM；已选择的 HTTP 操作失败时不自动换通道。

部分目录不能覆盖已有完整目录，也不能删除已有条目或清除正文索引、缓存和位置。后续补齐绑定首次导入的漫画身份及来源代次，移除漫画或断开来源后禁止迟到重建。首次完整结果成为更新基线，补齐首次目录不计为新增章节。目录失败或取消保留已确认内容及不完整标记；阅读器允许继续阅读和重试加载，自动同步仍按原有检查间隔执行。

归属解析期间的成功 HTTP 响应可通过 `storage.session` 一次性交给阅读器复用：按来源、章节、作品绑定，读取时重新检查主机权限，并精确匹配请求 URL 与 Referer。有效期 30 秒，过期后不再复用，存储内容在下一次交接操作时清理；最多 4 组、合计 4 MiB，每组限额统一为 2 MiB／8 个响应，导入失败或目录归属不符时清理对应记录。此机制不保存目录快照，不影响更新请求的新鲜度；交接不可用时照常 HTTP 读取。无站点语义的 HTML 属性、文本和惰性标记清理集中在 `shared/html.ts`，结构及协议校验留在各站目录。

HTTP 图片共用 `runtime/image-fetch.ts`：原位翻译由后台请求，阅读器由受信扩展页面请求，均先检查实际图片域名权限，再根据已校验的来源页生成 Referer。原位入口传递图片属性／meta 中的显式引用策略，缺省为 `strict-origin-when-cross-origin`；仅 HTTP 响应头声明的页面策略未回溯读取。站点 `image.headers` 只覆盖必要差异，不再为普通来源 Referer 增加专用适配。Blob／Data／Canvas 保留页面读取与导航版本校验。

同源 Blob 图片通过 `shared/blob-image.ts` 优先读取原字节；源站加载后撤销 URL、但已加载 `<img>` 仍可读时，按自然尺寸从该元素导出 PNG。读取前后核对元素、URL、尺寸、文档导航及取消状态，临时画布完成即释放；识别阶段不编码，也不保留全尺寸像素缓存。该能力由通用及显式站点的 `renderedImages` 共用，不适用于 HTTP 失败、跨域图片或污染画布，不改变 Blob 的临时资源边界。

展示画布无法导出但有可靠原图映射时，站点可返回 HTTP 原位目标，并通过 `image.decodeInline` 解码公共取图管线返回的字节；该钩子负责核对本站图片范围。网络解析器可按单次请求声明 `acceptStatuses` 以读取源站使用错误状态承载的结构化响应，仍须验证响应结构；权限、请求范围、响应大小和取消检查不变。

源站以表单 POST 提供只读目录或正文时，网络解析器可在 `request` 选项中传入 `form` 字符串字段；公共层编码为 `application/x-www-form-urlencoded`，编码后的请求体上限为 1 MiB，仍检查权限、Referer 归属、取消及响应大小。表单请求不使用或进入导入响应交接，防止同一 URL 的不同请求体误复用；未提供 `form` 的请求保持 GET。不得借此修改源站账户、内容或设置。

原位正文筛选由 `inlineTargets()` 负责：大图启发式集中在 `generic` 适配器，显示层统一检查渲染状态。网络适配器可通过 `inlineRecognition: 'generic'` 显式复用通用已加载大图识别，无需空 `page.ts`；注册表保持来源身份与通用尺寸检查，并禁止以此读取完整正文。这不是 HTTP 失败后的兜底。消息中的尺寸与来源能力由公共来源入口校验，翻译协议不解析站点。浏览器原位回归按 `sites/*/tests/verify-inline.mjs` 自动发现，各站导出 `verifyInline(context)`，站点专用开关与断言留在本站。

目录可选提供 `cover`，必须取自作品专门封面，不能使用推荐图或章节缩略图。`readSourceCover` 校验目录归属、HTTP(S) 地址与主机权限，经公共取图管线读取；防盗链规则不同时使用 `image.coverHeaders`。新增 CDN 仍须校验地址与当前访问权限，不单独弹出授权。封面不进入正文、翻译或下载清单，缩略图沿用缓存预算与访问失效规则；换封面不触发章节更新徽章。展示行为见[单来源阅读设计](SIMPLE_COMIC_READING_DESIGN.md)。

公共层使用 `webRequest` 在当前请求期间观察扩展自身精确 URL 的重定向响应头，配合 `fetch` 手动跳转，最多跟随 5 次；每跳检查权限与 URL，跨来源不转发站点请求头，重新生成来源 Referer。读取完成、失败或取消后移除监听与会话规则；不增加 debugger／页面捕获权限，不代理上传 Cookie。读取与验证规则见[公共图片读取](IMAGE_ACCESS.md)。

## 验收与交付

在 `apps/extension` 执行：

```powershell
npm run check
npm test
npm run build
```

`check` 包含类型和[模块边界检查](../apps/extension/scripts/check-modules.mjs)。测试至少覆盖 URL／伪造主机／资源归属、能力与安装元数据一致性、页序与重复 URL、部分／完整清单、取消及失效读取；有目录则覆盖重复条目、分组引用、更新和失败保留旧目录。源码类型与字段以契约为准，文档不维护第二份接口声明。

在桌面目标浏览器加载构建产物，实际完成导入 → 取图／解码 → 阅读 → 重开恢复，检查错误提示与阅读位置。按能力补测原位译图恢复、canvas 重绘／SPA 导航或无标签页网络读取；仅下载成功不能代替完整阅读器验收。

通用夹具、环境和启动顺序见[脚本入口](../scripts/README.md)。站点 README 只保留支持的 URL／能力、协议或依赖来源、可复现命令，以及各验证入口的环境与范围。区分隔离样本、真实站点、浏览器安装权限／撤权恢复与模型翻译效果；测试结果和截图写入忽略的产物目录，不在 README 追加流水记录。

## 现有站点

| 适配器 | 能力与说明 |
| --- | --- |
| [MangaCopy](../apps/extension/src/sources/sites/mangacopy/README.md) | HTTP 完整目录、网页章节发现与 HTTP 图片；动态只读分类、完整性核对、12 小时无目录标签页同步 |
| [Comix](../apps/extension/src/sources/sites/comix/README.md) | HTTP 目录／章节、图片还原、12 小时目录同步；已加载正文图片／还原画布的原位翻译，在详情页与章节页嵌入导入／管理入口 |
| [动漫屋 DM5](../apps/extension/src/sources/sites/dm5/README.md) | HTTP 完整目录／章节图片、12 小时更新；嵌入导入／管理按钮，章节 Referer；网页正文图片原位翻译 |
| [NAVER Webtoon](../apps/extension/src/sources/sites/naver/README.md) | Webtoon／Best Challenge／Challenge 的 HTTP 目录与图片、12 小时更新；嵌入导入／管理入口；网页正文切片原位翻译 |
| [WEBTOON 国际站](../apps/extension/src/sources/sites/webtoons/README.md) | 七语言 Originals／Canvas 搜索、HTTP 完整公开目录／正文／封面与 12 小时更新；网页导入及已加载正文原位翻译 |
| [瓜子漫画](../apps/extension/src/sources/sites/guazimanhua/README.md) | HTTP 完整目录／正文／封面、12 小时更新；嵌入作品与章节导入入口，HTTP 校验章节所属作品 |
| [包子漫画](../apps/extension/src/sources/sites/baozimh/README.md) | 简体站名称搜索、隐藏完整目录、跨页章节／整卷、封面与 12 小时更新；章节／续页导入、网页入口和 AMP 正文原位翻译 |
| [Comic PASH](../apps/extension/src/sources/sites/comicpash/README.md) | HTTP 完整分页目录／章节、图片还原、12 小时更新；嵌入作品导入入口；网页已渲染 canvas 原位翻译 |
| [MangaDex](../apps/extension/src/sources/sites/mangadex/README.md) | HTTP 多语言目录与章节、同话候选、作品封面、12 小时更新；章节 UUID 独立身份，图片内容标识不依赖临时服务器地址 |
| [MangaDot](../apps/extension/src/sources/sites/mangadot/README.md) | HTTP 名称搜索、多语言目录、普通／上传章节与整卷、封面和 12 小时更新；同话候选、网页导入与已加载正文原位翻译 |
| [漫画猫 00jf](../apps/extension/src/sources/sites/jf00/README.md) | HTTP 名称搜索、静态完整目录／正文／封面、12 小时更新；作品与章节导入、网页入口和已加载正文原位翻译 |
| [MangaBall](../apps/extension/src/sources/sites/mangaball/README.md) | HTTP 搜索、完整多语言分页目录／正文、封面定位和 12 小时更新；同话发布候选、裸章节归属、浮动入口和直接 CDN 正文原位翻译 |
| [Atsumaru](../apps/extension/src/sources/sites/atsu/README.md) | HTTP 名称搜索、完整目录／正文／封面、12 小时更新；按发布组独立连读、网页浮动入口和已加载正文原位翻译 |
| [RawOtaku](../apps/extension/src/sources/sites/rawotaku/README.md) | HTTP 名称搜索、完整语言目录／章节原图／封面、12 小时更新；作品与章节网页导入、两种阅读模式的正文原位翻译 |
| [KLManga](../apps/extension/src/sources/sites/klmanga/README.md) | HTTP 名称搜索、完整静态目录／封面与分批 POST 正文、12 小时更新；作品与章节导入、浮动入口，标签页翻译复用通用大图识别 |
| [Sunday Webry](../apps/extension/src/sources/sites/sundaywebry/README.md) | 名称搜索、HTTP 完整分页目录／正文／封面、GigaViewer 图片还原、12 小时更新；裸章节归属、网页导入和已加载正文原位翻译 |
| [Comic DAYS](../apps/extension/src/sources/sites/comicdays/README.md) | 复用 GigaViewer 引擎识别并还原已加载正文，支持原位翻译；不提供导入或目录 |
| [Manga One](../apps/extension/src/sources/sites/mangaone/README.md) | 阅读器内已解码同源 Blob 正文原位翻译，复用公共取图与动态页生命周期；不提供导入或目录 |
| [Pixiv](../apps/extension/src/sources/sites/pixiv/README.md) | 作者主页全集、插画、漫画、分类标签与单系列各按范围导入，每个作品一话；HTTP 完整目录与原图、系列源站排序、12 小时更新，网页翻译沿用通用识别 |
| `generic` | 已加载图片的原位翻译；不提供漫画导入或整章完整性承诺 |
