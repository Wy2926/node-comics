# 来源、当前内容与缓存架构

2026-09-23。当前代码使用单来源基线；产品行为见[单来源阅读](SIMPLE_COMIC_READING_DESIGN.md)，测试见[本轮验收](validation/SIMPLE_READING_2026_09_23.md)。旧作品聚合、章节归属、来源绑定数组和文件修订历史已删除。

## 元数据与身份

`Comic → Entry → PageDescriptor` 是可重建的读取索引。Comic 直接绑定一个 `ComicSource`；本地文件以完整容器摘要和大小去重，云盘以连接与 file ID 定位，网站以适配器与其稳定资源键定位。不同来源不合并。

Entry 保存来源条目标题、顺序、可选阅读序列、当前 contentId、索引状态与取页定位。文件只有一个隐式 Entry；网站分组保存在只读 catalog 快照中，同一条目可以多组引用。

PageDescriptor 保存当前内容身份、稳定页键、ordinal、尺寸和格式定位；无需先取得图片字节。实际解码后才产生 PageMaterialization，包括 SHA-256、字节数、尺寸和 renderProfile。翻译绑定按 API、用户和图片摘要隔离。

来源连接、当前内容 generation、文件快照与 contentId 用于拒绝失效写入，不提供版本浏览、旧文件访问或源替换命令。

## 新库基线

[storage/database.ts](../apps/extension/src/storage/database.ts)统一使用 `node-comics-reading-v1-*`，初始版本 1。目录库包括 comics、entries、connections、pageDescriptors、materializations、positions、catalogs、tasks、translationBindings、translationOperations、metadata、tombstones。

不扫描、升级或读取旧库，也没有双写、别名、迁移链。当前基线缺表会明确报告结构不一致，不能静默重建用户数据。删除使用 tombstone 和内容代次保护迟到写入；catalog 是来源资源快照，重新导入时允许在新的漫画身份下重新创建。

## 本地与云盘

[容器服务](../apps/extension/src/storage/containers/index.ts)将完整文件保存到有界分块 IndexedDB，边复制边摘要。持久导入日志仅引用已保存容器；只有格式校验和索引完成后才发布漫画。失败释放本次持有引用，不留下空漫画。关闭页面后未保存的 File 不可恢复。

本地只允许 CBZ/ZIP、CBR/RAR、PDF、未加密 MOBI，图片仅作为容器内部页面。索引、解压和页面渲染由[格式模块](../apps/extension/src/comics/formats/README.md)完成；字节按需取得，不预先展开并保存整本。

Google Drive 只支持 CBZ/ZIP 的 Range 读取。Picker 过滤文件 MIME；元数据和格式入口再次拒绝图片。连接账户、resource key、版本和大小须核验；不支持的随机访问格式不能偷偷回退为整包下载。撤权和断开递增连接代次，关闭资源并阻止在途索引发布。重新选择文件才恢复明确选中的访问范围。

## 专用网站与页面服务

导入要求适配器声明 `importable`、页面能力和明确的 reader/catalog 地址。未知网页不能导入；通用图片发现仅供原位翻译。目录验证来源、所属资源、条目与分组引用，分类只读而不固化为核心业务类型。

网站发现、页面字节和主动下载分离。已登记 HTTP 地址可在受管标签页关闭后读取；canvas 页必须通过当前标签页、文档和导航绑定的资源句柄获取，不能把临时句柄当作离线图片。部分清单不能被标记完整。

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
- [适配器架构](SOURCE_ADAPTER_ARCHITECTURE.md)与[格式边界](IMPORT_FORMATS_AND_CACHE.md)

后端结果复用、持久任务、额度和共享对象保留沿用[阅读计划契约](READING_TRANSLATION_CONTRACT.md)，本次没有改变结算或生产存储策略。
