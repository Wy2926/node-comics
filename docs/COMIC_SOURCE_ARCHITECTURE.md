# 来源、当前内容与缓存架构

当前代码使用单来源基线；产品行为见[单来源阅读](SIMPLE_COMIC_READING_DESIGN.md)，复验见[脚本入口](../scripts/README.md)。

## 元数据与身份

`Comic → Entry → PageDescriptor` 是可重建的读取索引。Comic 直接绑定一个 `ComicSource`；本地文件以完整容器摘要和大小去重，云盘以连接与 file ID 定位，网站以适配器与其稳定资源键定位。不同来源不合并。

Entry 保存来源条目标题、顺序、可选阅读序列、当前 contentId、索引状态与取页定位。文件只有一个隐式 Entry；网站分组保存在只读 catalog 快照中，同一条目可以多组引用。

PageDescriptor 保存当前内容身份、稳定页键、ordinal、尺寸和格式定位；无需先取得图片字节。实际解码后才产生 PageMaterialization，包括 SHA-256、字节数、尺寸和 renderProfile。翻译绑定按 API、用户和图片摘要隔离。

来源连接、当前内容 generation、文件快照与 contentId 用于拒绝失效写入，不提供版本浏览、旧文件访问或源替换命令。

## 新库基线

[storage/database.ts](../apps/extension/src/storage/database.ts)统一使用 `node-comics-reading-v2-*`，初始版本 1。目录库包括 comics、entries、connections、pageDescriptors、materializations、positions、catalogs、tasks、translationBindings、metadata、tombstones。

不扫描、升级或读取旧库，也没有双写、别名、迁移链。当前基线缺表会明确报告结构不一致，不能静默重建用户数据。删除使用 tombstone 和内容代次保护迟到写入；catalog 是来源资源快照，重新导入时允许在新的漫画身份下重新创建。

## 文件来源驱动

[contracts.ts](../apps/extension/src/comics/sources/contracts.ts) 定义选择、打开和访问变化契约，[registry.ts](../apps/extension/src/comics/sources/registry.ts) 注册能力，[runtime.ts](../apps/extension/src/comics/sources/runtime.ts) 负责范围缓存与关闭失效读取，[install.ts](../apps/extension/src/comics/sources/install.ts) 显式装配来源。新增同格式文件来源实现驱动并注册，不修改阅读器、页面服务或翻译。

驱动核验自己的账户、资源与冻结快照，只获取字节和通知访问变化；不导入仓储、应用、其他驱动或缓存策略。公共核心不解析供应商私有字段，也不把未知来源猜成 Google Drive。来源打开或读取期间撤权，迟到实例关闭、结果拒绝；重新选择只恢复明确核实的文件范围。

## 本地与云盘

[容器服务](../apps/extension/src/storage/containers/index.ts)将完整文件保存到有界分块 IndexedDB，边复制边摘要。持久导入日志仅引用已保存容器；只有格式校验和索引完成后才发布漫画。失败释放本次持有引用，不留下空漫画。关闭页面后未保存的 File 不可恢复。

本地只允许 CBZ/ZIP、CBR/RAR、PDF、未加密 MOBI，图片仅作为容器内部页面。索引、解压和页面渲染由[格式模块](../apps/extension/src/comics/formats/README.md)完成；字节按需取得，不预先展开并保存整本。

Google Drive 支持 CBZ/ZIP、未加密 MOBI 的 Range 读取。MOBI 复用通用格式模块，按记录表和正文引用建索引，取页只读取对应图片记录；驱动不解析正文，格式、应用和阅读器不读取 Drive 私有字段。各浏览器统一跳转 Google 顶层授权与选文件；元数据核验文件扩展名、排除图片和在线文档，格式入口再校验真实内容。连接账户、resource key、版本和大小须核验；不支持的随机访问格式不能偷偷回退为整包下载。撤权和断开递增连接代次，关闭资源并阻止在途索引发布。重新选择文件才恢复明确选中的访问范围。

云盘导入完成后，已校验的索引分段缓存从临时导入归属转交给漫画条目，封面和阅读器复用这些区间；失败导入仍清理临时缓存，移除漫画仍清理其缓存。MOBI 的连续正文记录合并为一次有界读取，再按记录边界解析；索引阶段不读图片，也不逐条记录触发云端往返。Drive 的每次实际 Range 读取仍保留前后版本核验。

## 账户展示注册

设置中的账户通过文件来源注册契约 `FileSourceDriver.listAccounts()` 读取，`subscribeAccounts()` 通知授权状态变化，`describeAccount(account)` 返回纯文本的 `{id,label,value}` 字段列表。应用层按来源和账户身份合并授权后台与漫画目录已有的记录，UI 不读取供应商私有字段或判断供应商 ID。账户列表独立于缓存统计加载；某个来源失败时显示原因和重试入口，不把读取失败显示为“暂无云盘账户”，也不影响其他来源。

`SourceAccount` 是展示快照，不携带漫画访问代次；读取账户不创建目录记录或恢复文件访问。来源选择成功时，即使没有选择文件也保存 `SourceConnection`。选择返回的 `accountMetadata` 只允许非敏感展示资料，保存在本机；重新选择或连接时刷新，资料变化不增加访问代次。Google Drive 的列表仅投影插件已核验的本地连接与会话账户，不返回令牌、不调用 OAuth、不探测浏览器登录账户；仅连接账户、尚未导入漫画时也可显示。账户记录跨浏览器重启保留，用于再次进入云盘时自动跳转 Google；令牌只在可信会话中保存，断开会删除自动跳转记录。

Google Drive 驱动从已验证的 `about.user` 响应读取名称和可选邮箱，并注册邮箱与账户标识字段；邮箱缺失时省略，设置页展示来源、名称与已知连接状态。网页授权到期或保存的连接已没有可用会话时提示重新连接，账户列表本身不远程验证授权。字段依据 [Google Drive User](https://developers.google.com/workspace/drive/api/reference/rest/v3/User)。新来源只需实现并注册同一账户契约；无专属字段的来源仍显示基本连接信息。

## 专用网站与页面服务

导入要求适配器声明 `importable`、页面能力和明确的 reader/catalog 地址。未知网页不能导入；通用图片发现仅供原位翻译。目录验证来源、所属资源、条目与分组引用，分类只读而不固化为核心业务类型。

网站发现、页面字节和主动下载分离。已登记 HTTP 地址可在受管标签页关闭后读取；canvas 页必须通过当前标签页、文档和导航绑定的资源句柄获取，不能把临时句柄当作离线图片。部分清单不能被标记完整。

网站原图的网络读取使用 `cache: 'no-store'`，跳过浏览器 HTTP 缓存，避免源站带缓存头的 503 等失败响应阻塞重试。已校验的图片仍复用原图页缓存或显式下载资料；此策略不改变这些应用缓存的保留规则。

[PageService](../apps/extension/src/comics/pages/service.ts)通过 Entry 的唯一 Comic.source 获取字节。读取前后核验当前 contentId、generation、连接和来源状态；页面物化和翻译恢复使用实际字节摘要。内容改变时新索引原子替换旧索引，位置回当前条目第一页；不会把旧页码映射到新内容。

## 独立存储职责

| 存储 | 职责 |
| --- | --- |
| 完整源文件容器 | 本地可恢复的漫画文件，引用释放后再回收 |
| 原图页缓存 | 已解码页面的可清理缓存 |
| 来源分段缓存 | 云盘已取得的字节区间 |
| 缩略图缓存 | 有界书架／页面缩略图 |
| 译图缓存 | 账户授权范围内的译图缓存 |
| 显式下载资料 | 用户主动保留的网站原图，不受普通缓存清理影响 |
| 原图副本授权 | 本人有效 R2 asset 引用，不是云书架或额外漫画来源 |

阅读器只加载当前及相邻内容的有限图片窗口。缓存命中不代表完整离线；断网失败保留可操作原因。下载任务持久化，暂停、恢复和取消幂等；来源断开后旧任务不能写回。

移除漫画撤销其元数据、位置及持有引用；不删除原磁盘文件、云盘文件、源站内容或后端共享 R2。清缓存不改变源文件、阅读位置或漫画身份。

## 实现入口

- [领域模型](../apps/extension/src/comics/domain/index.ts)与[事务仓储](../apps/extension/src/comics/repositories/index.ts)
- [导入服务](../apps/extension/src/comics/application/import-service.ts)与[自动队列](../apps/extension/src/comics/application/import-queue.ts)
- [来源运行时](../apps/extension/src/comics/sources/runtime.ts)、[来源权限](../apps/extension/src/comics/application/source-access.ts)与[页面服务](../apps/extension/src/comics/pages/service.ts)
- [适配器架构](SITE_ADAPTERS.md)与[格式边界](IMPORT_FORMATS_AND_CACHE.md)

后端结果复用、持久任务、额度和共享对象保留沿用[翻译接口契约](READING_TRANSLATION_CONTRACT.md)，本次没有改变结算或生产存储策略。
