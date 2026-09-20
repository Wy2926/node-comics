# Node Comics 架构 v0.4

2026-09-19：[阅读计划契约](READING_TRANSLATION_CONTRACT.md)已实现：滚动 60 秒普通 30／PLUS 100 张新增翻译、逐页受理与幂等恢复，取消账户在途数量上限。最终新库基线 `results_0001`，旧提交／用户队列契约、结构和迁移链直接删除。现有环境切换与公开部署单独处理。调度与启动见[集群设计](TRANSLATION_CLUSTER_DESIGN.md)和[后端说明](../backend/README.md)。

## 结构

WXT + React + TypeScript 客户端；FastAPI + SQLAlchemy/Alembic 控制服务；PostgreSQL 保存任务、阶段、排序、租约、权益、调用成本与检查点；私有 R2 保存原图和最终译图。

API、control-worker 和 maintenance 独立运行。图像节点 classic_node 经认证 API 领取整页租约，在节点内编排检测、OCR、抹字和嵌字；中心独立处理 text 工作。节点不连接数据库，不持有 R2/LLM 长期密钥，不依赖共享图片目录。详见[计算协议](COMPUTE_PROTOCOL.md)；重绘使用单独执行池和供应商限制。

## 漫画管理领域模型

作品管理按漫画内容与出版关系建立来源无关模型，见[通用漫画作品管理设计](COMIC_LIBRARY_DESIGN.md)。已实现作品、章节、内容版本、出版套系、卷册及收录关系，来源目录通过映射关联`ReadingCopy`。`Chapter`表示章节内容，不保存图片；页面与阅读锚点属于副本及其清单修订。使用独立 IndexedDB `node-comics-library`，事务协调元数据与副本身份，Web Locks 协调来源采集。旧扁平书架及存储模块已删除，没有旧数据迁移、兼容字段或结构回退。模块与运行证据见[实现记录](COMIC_LIBRARY_IMPLEMENTATION.md)。

MangaCopy是来源适配器之一，具体入口、原始标签映射和图片发现规则见[来源设计](MANGACOPY_LIBRARY_DESIGN.md)。站点分组、URL、章节UUID和图片地址不充当全局领域身份；源站变化不要求修改核心类的含义。

## 插件与导入

站点适配器随插件发布，图片发现、字节获取、后端翻译分别管理。通用模式不声称完整章节。activeTab/scripting/storage/contextMenus与登录identity按功能使用，网站权限按需申请。消息校验sender、标签页、导航版本和登记资源，禁止任意跨域代理。凭据仅在可信扩展上下文。

清单、任务ID、原图与结果Blob存IndexedDB；Blob URL每次重建并撤销。连续阅读有限窗口解码，页面ID+相对位置恢复，原图尺寸占位。结果增量由可见阅读器或网页内容脚本驱动长轮询，重开核实操作回执，不依赖MV3后台常驻。

MOBI按Blob分段读取PDB表与有限正文，解析PalmDOC和recindex；不执行电子书HTML，不全量读200MB文件进ArrayBuffer，不在解析时解码全卷。检查DRM、压缩、越界、展开大小、页数与单页限制。

## AI 图片协议

公开产品 API 统一为 `POST /v1/translation-plans`，每项声明原图摘要、字节数、可选文件页身份；上传受理后走有限字节的上传会话。业务生成输入仍只有原图与目标语言，后端构造提示词，无重绘前置 OCR。

图片供应商适配器调用兼容 `POST /v1/images/edits`，配置 endpoint、model、image/image[]、参数白名单、尺寸和超时。密钥仅引用后端环境变量。输出 URL 进行域名、DNS/IP 和重定向检查；可解码、归属正确、持久化成功后交付。聊天接口或模型列表不构成图片编辑验收。

文本翻译独立使用数据库中的 `TranslationProvider` 和不可变 `TranslationProviderRevision`，不读取旧 `TEXT_*` 或借用图片供应商配置。后台可创建多个 OpenAI 供应商并选择默认，任务固定供应商版本，运行时解析该版本的后台密钥。渠道注册表隔离来源差异，首期实现 Chat Completions 与 Responses；按供应商独立限流，统一执行器负责重试、计量和检查点。详细接口与部署边界见 [LLM 翻译供应商](TRANSLATION_PROVIDERS.md)。

## 任务、权益与数据

- Job 保存内容/模式/语言/有效生成配置；TranslationOperation 保存逐页幂等回执；ReadingSession 保存至多三页窗口与序号；ImageAdmission 保存新增翻译的滚动分钟事件；UploadReservation 保存字节校验前的有限上传会话。
- JobStage 保存依赖和代次，ExecutionLease 保存资源执行权，FairnessState 保存真实占用时间校正的加权服务量，UserModeQueue 仅保存模式阅读控制权与 epoch。
- User、QuotaPeriod、MembershipOperation、Ledger 实现普通／PLUS、周期页数和限时赠送；供应商 Attempt/TextCall 成本独立计量。
- 原图以内容 SHA-256 全局匹配，FilePage 按用户/文件哈希/原始页索引识别。无字结果与有效译图按模式、语言、有效配置版本跨账户复用；`translation_results` 只登记真实生成的版本，`result_accesses` 每用户／版本最多一条授权，缓存命中不创建 Job，也不进入任务历史。过期或删除授权不作为复用来源；进行中的跨账户任务独立调度。候选匹配在全局锁外执行，锁内按主键复核，详见[译图共享与匹配](RESULT_SHARING.md)。
- 任务状态从 awaiting_upload/validating_upload 进入 queued/running，再到 succeeded/no_text/failed/cancelled/outcome_unknown。未知期限释放后仍保留 unknown_released 成本证据，不自动重发重绘。
- 受理、排序、租约、终态和结算在一致锁顺序下事务提交。首次交付冻结结果摘要，在租约记录最终字节 SHA-256 对应的不可变共享对象键；晚到计算和重复网络通知不能覆盖已交付版本或重复扣量。
- 账户增量游标由事务锁下的单调序列赋值，避免先分配序列、后提交造成客户端漏读。历史分页用固定查询数的数据库投影，不读整份供应商配置，不探测 R2。
- 原图/译图默认无限期保留，最近授权访问时间为后续闲置清理提供依据；活跃任务引用保护原图。常规缓存可丢弃，OCR/译文检查点持久化。详见[存储说明](OBJECT_STORAGE.md)。

## 身份与运维

生产 OIDC 验证 JWT 签名、issuer、audience、到期，浏览器授权码 + PKCE 并校验 state。后端默认生产模式，身份配置不完整时拒绝启动；JWKS 仅保留最长 300 秒的集合缓存。DEV_AUTH 仅显式开发 / 测试环境、随机签名密钥、127.0.0.1 绑定，不能用于公开部署。配置与验证边界见[生产身份说明](PRODUCTION_IDENTITY.md)。

每个图片／任务／提交回执检查归属。用户删除先提交本人授权墓碑，并丢弃尚未交付的输出；不删除其他账户授权或共享持久对象。原图 / 译图默认无限期保留，不扫描删除一天前或无数据库引用的对象，数据库恢复不会触发此类误删。数据库备份与独立恢复流程见[运维说明](OPERATIONS.md)。日志只记录任务 ID、错误、阶段、耗时和脱敏计量。

公开发布仍需真实 OIDC 账号登录验收、身份服务回调与来源登记核实、HTTPS 部署及目标站点和供应商质量验收。构建、本地运行和公开部署分别报告。
