# 来源、当前内容与缓存架构

当前代码使用单来源基线；产品行为见[单来源阅读](SIMPLE_COMIC_READING_DESIGN.md)，复验见[脚本入口](../scripts/README.md)。

## 元数据与身份

`Comic → Entry → PageDescriptor` 是可重建的读取索引。Comic 直接绑定一个 `ComicSource`；本地文件以完整容器摘要和大小去重，云盘以连接与 file ID 定位，网站以适配器与其稳定资源键定位，远程书库以连接与出版物 ID 定位。不同来源不合并。

Entry 保存来源条目标题、顺序、可选阅读序列、当前 contentId、索引状态与取页定位。文件只有一个隐式 Entry；网站分组保存在只读 catalog 快照中，同一条目可以多组引用。

网站条目可保存源内容语言、来源证明的阅读位置键、可读状态及源快照顺序；它们参与按话合并目录与连读导航，不合并条目身份。每本漫画的明确候选选择与最近打开条目存于 metadata，绑定漫画及来源代次，删除漫画时一并移除。自动选择使用当前翻译目标语言，不额外保存语言筛选，也不把自动选择写成手动偏好。目录同步保留所有语言，读取偏好不改变来源快照。

PageDescriptor 保存当前内容身份、稳定页键、ordinal、尺寸和格式定位；无需先取得图片字节。实际解码后才产生 PageMaterialization，包括 SHA-256、字节数、尺寸和 renderProfile。翻译绑定按 API、用户和图片摘要隔离。

网站 HTTP 页可声明稳定的源内容键；页槽与内容键共同构成页面身份，下载 URL 仅作当前取图定位。临时 CDN 地址轮换只更新定位，内容键变化仍走明确内容替换；源内容键不代替实际字节摘要校验。

来源连接、当前内容 generation、文件快照与 contentId 用于拒绝失效写入，不提供版本浏览、旧文件访问或源替换命令。

## 新库基线

[storage/database.ts](../apps/extension/src/storage/database.ts)统一使用 `node-comics-reading-v2-*`，默认版本 1。目录库包括 comics、entries、connections、pageDescriptors、materializations、positions、catalogs、tasks、metadata、tombstones；渠道绑定单独保存于 `channel-bindings` 库。

不扫描或读取更早的开发基线。当前基线的结构变更由所属存储模块显式声明版本和升级回调，在 IndexedDB 升级事务内完成；公共打开层只管理版本、结构检查与连接关闭，不推断迁移、不删除重建用户数据。未声明升级的缺表仍明确报告结构不一致。

官方请求库使用版本 2：操作日志保留幂等 UUID，任务快照按 scope／UUID 分条保存并按来源图片索引查询，sync 只保存退避控制字段；版本 1 的任务数组在同一升级事务内搬入任务表，失败自动回滚。阅读器和翻译调度器不承担迁移。旧回执按原 UUID 归入历史，操作状态只在 UUID 仍匹配时以同一事务更新。删除使用 tombstone 和内容代次保护迟到写入；catalog 是来源资源快照，重新导入时允许在新的漫画身份下重新创建。

## 来源能力与装配

[contracts.ts](../apps/extension/src/comics/sources/contracts.ts) 的 `SourceProvider` 按能力组合连接、远程目录、文件、页面与封面；[registry.ts](../apps/extension/src/comics/sources/registry.ts) 统一注册，[runtime.ts](../apps/extension/src/comics/sources/runtime.ts) 负责范围缓存与关闭失效读取，[install.ts](../apps/extension/src/comics/sources/install.ts) 显式装配来源。本地和 Drive 的文件驱动注册输入转换到同一能力记录，不维护第二套注册中心。新增来源只实现其实际能力，不修改阅读器、页面服务或翻译。

一个 provider 可有多个独立连接，一个连接可浏览多个目录与出版物。远程书库 UI 只枚举具备目录能力的 provider；连接表单字段由 provider 提供，UI 不读取私有账户结构。Komga、Kavita 等支持 OPDS 的服务是同一协议的不同连接，不按服务器品牌复制公共分支。其他协议须有实际需求才实现，不因预留接入点而增加空驱动。

驱动核验自己的账户、资源与冻结快照，只获取字节和通知访问变化；不导入仓储、应用、其他驱动或缓存策略。公共核心不解析供应商私有字段，也不把未知来源猜成 Google Drive。来源打开或读取期间撤权，迟到实例关闭、结果拒绝；重新选择只恢复明确核实的文件范围。

## 本地与云盘

[容器服务](../apps/extension/src/storage/containers/index.ts)将完整文件保存到有界分块 IndexedDB，边复制边摘要。持久导入日志仅引用已保存容器；只有格式校验和索引完成后才发布漫画。失败释放本次持有引用，不留下空漫画。关闭页面后未保存的 File 不可恢复。

本地只允许 CBZ/ZIP、CBR/RAR、PDF、未加密 MOBI，图片仅作为容器内部页面。索引、解压和页面渲染由[格式模块](../apps/extension/src/comics/formats/README.md)完成；字节按需取得，不预先展开并保存整本。

Google Drive 支持 CBZ/ZIP、未加密 MOBI 的 Range 读取。MOBI 复用通用格式模块，按记录表和正文引用建索引，取页只读取对应图片记录；驱动不解析正文，格式、应用和阅读器不读取 Drive 私有字段。各浏览器统一跳转 Google 顶层授权与选文件；元数据核验文件扩展名、排除图片和在线文档，格式入口再校验真实内容。连接账户、resource key、版本和大小须核验；不支持的随机访问格式不能偷偷回退为整包下载。撤权和断开递增连接代次，关闭资源并阻止在途索引发布。重新选择文件才恢复明确选中的访问范围。

云盘导入完成后，已校验的索引分段缓存从临时导入归属转交给漫画条目，封面和阅读器复用这些区间；失败导入仍清理临时缓存，移除漫画仍清理其缓存。MOBI 的连续正文记录合并为一次有界读取，再按记录边界解析；索引阶段不读图片，也不逐条记录触发云端往返。Drive 的每次实际 Range 读取仍保留前后版本核验。

## 远程书库与 OPDS

远程书库是浏览入口，不是批量导入器。连接并授权后按页读取目录、分组、筛选、下一页和搜索；目录只读，不扫描完整服务器，不把浏览结果写成 Comic。第一次打开出版物才登记唯一来源和可读索引，后续打开复用漫画与阅读位置；服务器重名、相同出版物 ID 或不同账户之间不会串书。

[OPDS provider](../apps/extension/src/comics/sources/opds/provider.ts) 支持 OPDS 1.2 Atom、OPDS 2 JSON、部分出版物详情、OpenSearch 和常见查询模板。XML 使用浏览器原生 `DOMParser`，拒绝 DTD／实体声明并限制文档大小和树深；`@xmldom/xmldom` 仅作为 Node 测试的开发依赖，不随插件引入另一套 XML 解析器。[r2-opds-js 官方](https://github.com/edrlab/r2-opds-js#npm-package)声明只支持 Node.js，未引入其文件系统／归档／DRM 依赖；协议模型规范化留在 provider 内。

目录展示与实际打开共用链接分类：已确认可读、需按需展开详情／图片清单、明确不支持三种情况分开处理。不能仅因同时存在 EPUB 下载链接就禁用可能的图片清单；展开后仅含 XHTML 的 EPUB 正文仍不支持，不读取正文或写服务端进度。不可读原因区分 EPUB、DRM／借阅／购买、非只读页流及未知表示，不向用户暴露私有资源地址。标准 RAR MIME `application/vnd.rar` 与既有漫画归档别名使用同一格式映射，不按服务品牌分支。

解析器不决定如何阅读。`catalog.resolve` 返回当前资源的 `pages`、`range-file` 或 `download-file` 计划：

- 图片型 Divina/Web Publication 或可安全只读的 OPDS-PSE 生成 `image-sequence` Entry。封面不是正文，HTML／音频 Web Publication 不作为漫画页序列。
- CBZ／ZIP、未加密 MOBI 仅在服务器提供可核验的 206 Range、大小与强 ETag 时按需读取；忽略 Range、内容变化或无法证明快照一致性时不能静默整包读取。
- 需要完整文件的资源由用户确认后流式保存，包括 PDF／CBR 和不满足 Range 条件的支持格式。完成格式校验与索引后才发布漫画；中断不发布空漫画。下载复用完整容器存储，不引入第三套图片仓库。

远程书库与书架共用下载确认和任务入口。完整文件的归属引用先建立，再将漫画索引与任务完成态原子发布；发布成功后的临时引用清理失败不得回滚已发布文件。未完成的清理保留容器定位，交给恢复流程重试。没有独立封面时，漫画保存封面页的实际格式，用当前渲染配置生成缩略图，不从 provider 私有定位或下载地址猜格式。

显式重新载入先重新解析当前计划与准备完整索引，再原子替换定位、快照和页面身份。图片流重新载入建立新内容身份并回到第一页，避免服务器静默改图后旧物化信息阻塞恢复；普通打开和重连不重置位置。可靠 Range 文件快照未变则保留位置，变化后回到第一页。独立封面按来源代次失效，即使封面地址或引用 ID 未变也重新读取。不保留历史版本，不在不同表示之间自动切换；完整文件变化需明确重新保存。

凭据和实际取图／下载地址保存在 provider 私有库；公共目录、任务及封面只保存不透明引用。支持匿名、HTTPS Basic 和令牌地址；凭据不上传后端，不进入默认日志。请求仅 GET／HEAD、同源、无 Cookie／Referer，拒绝重定向与跨源取图。不同域名的 CDN、OAuth／交互认证、借阅／购买、DRM、完整 RFC6570 模板和服务端进度同步不在当前支持范围；遇到它们明确报错，不承诺兼容全部 OPDS 服务。已知会写阅读进度的 Kavita PSE 图片路由不调用。

每次目录响应上限 4 MiB，单页最多 2000 个不透明引用，超出时提示缩小服务端分页；传输并发最多 4。封面仅在邻近视口时加载，并发最多 2，离开时释放 URL。浏览引用仅在有界内存中保存；选中阅读的必要引用才持久化。历史只保留最多 32 个位置，不缓存整库。下载上限沿用完整容器限制 512 MiB；普通阅读原图不为节省流量降采样。

断开清除授权并中止在途请求，保留漫画与阅读记录；显式断开后不能继续通过普通缓存或离线资料绕过来源状态。重连恢复同一目录与账户的访问，不替换为另一服务器，不自动恢复暂停的下载。来源读取和翻译仍是独立授权流程。

真实联调入口为 [verify_opds_live.mjs](../scripts/verify_opds_live.mjs)，使用公开 Komga 服务器的真实目录、封面、原图及 CBZ；隔离扩展 profile，不伪造 OPDS 响应，不写远端进度，不调用翻译。

## 账户展示注册

设置中的来源连接通过 `SourceProvider.connection.list/subscribe/describe` 读取和订阅，描述字段为纯文本的 `{id,label,value}` 列表；既有文件驱动的账户方法由 registry 转换。应用层按来源和账户身份合并授权后台与漫画目录已有的记录，UI 不读取供应商私有字段或判断供应商 ID。账户列表独立于缓存统计加载；某个来源失败时显示原因和重试入口，不把读取失败显示为空列表，也不影响其他来源。远程书库只读取具备目录能力的连接，不初始化文件专用账户。

`SourceAccount` 是展示快照，不携带漫画访问代次；读取账户不创建目录记录或恢复文件访问。来源选择成功时，即使没有选择文件也保存 `SourceConnection`。选择返回的 `accountMetadata` 只允许非敏感展示资料，保存在本机；重新选择或连接时刷新，资料变化不增加访问代次。Google Drive 的列表仅投影插件已核验的本地连接与会话账户，不返回令牌、不调用 OAuth、不探测浏览器登录账户；仅连接账户、尚未导入漫画时也可显示。账户记录跨浏览器重启保留，用于再次进入云盘时自动跳转 Google；令牌只在可信会话中保存，断开会删除自动跳转记录。

Google Drive 驱动从已验证的 `about.user` 响应读取名称和可选邮箱，并注册邮箱与账户标识字段；邮箱缺失时省略，设置页展示来源、名称与已知连接状态。网页授权到期或保存的连接已没有可用会话时提示重新连接，账户列表本身不远程验证授权。字段依据 [Google Drive User](https://developers.google.com/workspace/drive/api/reference/rest/v3/User)。新来源只需实现并注册同一账户契约；无专属字段的来源仍显示基本连接信息。

## 专用网站与页面服务

导入要求适配器声明 `importable`、页面能力和明确的 reader/catalog 地址。未知网页不能导入；通用图片发现仅供原位翻译。目录验证来源、所属资源、条目与分组引用，分类只读而不固化为核心业务类型。

网站发现、页面字节和主动下载分离。已登记 HTTP 地址可在受管标签页关闭后读取；canvas 页必须通过当前标签页、文档和导航绑定的资源句柄获取，不能把临时句柄当作离线图片。部分清单不能被标记完整。

网站原图的网络读取使用 `cache: 'no-store'`，跳过浏览器 HTTP 缓存，避免源站带缓存头的 503 等失败响应阻塞重试。已校验的图片仍复用原图页缓存或显式下载资料；此策略不改变这些应用缓存的保留规则。

[PageService](../apps/extension/src/comics/pages/service.ts)通过 Entry 的唯一 Comic.source 获取字节。读取前后核验当前 contentId、generation、连接和来源状态；页面物化和翻译恢复使用实际字节摘要。内容改变时新索引原子替换旧索引，位置回当前条目第一页；不会把旧页码映射到新内容。

阅读和下载统一经 `prepareEntryContent` 判断是否需要发现、重载或刷新临时地址。下载调用可复用刚核实的同 contentId 保存页数，避免重复读取离线清单；不同内容身份不能复用该结果。

## 独立存储职责

| 存储 | 职责 |
| --- | --- |
| 完整源文件容器 | 本地可恢复的漫画文件，引用释放后再回收 |
| 原图页缓存 | 规范化的实际送译／阅读字节，可清理；与来源容器身份分开 |
| 来源分段缓存 | 云盘已取得的字节区间 |
| 缩略图缓存 | 有界书架／页面缩略图 |
| 译图缓存 | 按渠道作用域隔离的完整译图；官方覆盖首次合成后保存整页，重绘与 MTU 保存完整结果 |
| 显式下载资料 | 用户主动保留的网站／远程页序列原图，不受普通缓存清理影响；完整文件下载使用完整容器 |

页面服务按 `original-v2-static-srgb` 处理静态首帧、EXIF 方向和 sRGB 语义，只有需要的输入重编码；送译摘要对应实际缓存字节。中心不提供原图恢复，常规覆盖合成必须配合同摘要原图，完整译图缓存命中后可独立读取；完整译图缺失且原图来源和缓存均不可用时明确报错。

阅读器只加载当前及相邻内容的有限图片窗口。缓存命中不代表完整离线；断网失败保留可操作原因。下载任务持久化，暂停、恢复和取消幂等；来源断开后旧任务不能写回。

移除漫画撤销其元数据、位置及持有引用；不删除原磁盘文件、云盘文件、源站内容或后端翻译结果。清缓存不改变源文件、阅读位置或漫画身份。

## 实现入口

- [领域模型](../apps/extension/src/comics/domain/index.ts)与[事务仓储](../apps/extension/src/comics/repositories/index.ts)
- [导入服务](../apps/extension/src/comics/application/import-service.ts)与[自动队列](../apps/extension/src/comics/application/import-queue.ts)
- [来源运行时](../apps/extension/src/comics/sources/runtime.ts)、[来源权限](../apps/extension/src/comics/application/source-access.ts)与[页面服务](../apps/extension/src/comics/pages/service.ts)
- [适配器架构](SITE_ADAPTERS.md)与[格式边界](IMPORT_FORMATS_AND_CACHE.md)

后端结果复用、持久任务、额度和账户内结果保留沿用[翻译接口契约](READING_TRANSLATION_CONTRACT.md)。
