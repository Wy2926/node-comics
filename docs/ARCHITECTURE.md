# Node Comics 架构 v0.4

2026-09-15：前后端翻译调度已改为持久提交清单、双模式加权阶段队列与独立计算节点。规则、算法、API 和故障边界见[集群设计与实现](TRANSLATION_CLUSTER_DESIGN.md)，启动见[后端说明](../backend/README.md)。新基线 `nodes_0001`，无旧结构兼容。

## 结构

WXT + React + TypeScript 客户端；FastAPI + SQLAlchemy/Alembic 控制服务；PostgreSQL 保存任务、阶段、排序、租约、权益、调用成本与检查点；私有 R2 保存原图和最终译图。

API、control-worker 和 maintenance 独立运行。图像 compute-agent 在设备空闲时经认证 API 领取阶段，调用本机常驻引擎；不连接数据库，不持有 R2/LLM 密钥，不依赖共享图片目录。常规阶段 analyze → text/inpaint 并行 → render；重绘使用单独执行池和供应商限制。

## 漫画管理领域模型

作品管理按漫画内容与出版关系建立来源无关模型，见[通用漫画作品管理设计](COMIC_LIBRARY_DESIGN.md)。已实现作品、章节、内容版本、出版套系、卷册及收录关系，来源目录通过映射关联`ReadingCopy`。`Chapter`表示章节内容，不保存图片；页面与阅读锚点属于副本及其清单修订。使用独立 IndexedDB `node-comics-library`，事务协调元数据与副本身份，Web Locks 协调来源采集。旧扁平书架及存储模块已删除，没有旧数据迁移、兼容字段或结构回退。模块与运行证据见[实现记录](COMIC_LIBRARY_IMPLEMENTATION.md)。

MangaCopy是来源适配器之一，具体入口、原始标签映射和图片发现规则见[来源设计](MANGACOPY_LIBRARY_DESIGN.md)。站点分组、URL、章节UUID和图片地址不充当全局领域身份；源站变化不要求修改核心类的含义。

## 插件与导入

站点适配器随插件发布，图片发现、字节获取、后端翻译分别管理。通用模式不声称完整章节。activeTab/scripting/storage/contextMenus与登录identity按功能使用，网站权限按需申请。消息校验sender、标签页、导航版本和登记资源，禁止任意跨域代理。凭据仅在可信扩展上下文。

清单、任务ID、原图与结果Blob存IndexedDB；Blob URL每次重建并撤销。连续阅读有限窗口解码，页面ID+相对位置恢复，原图尺寸占位。轮询在可见阅读器退避执行，重开查询服务端，不依赖MV3后台常驻。

MOBI按Blob分段读取PDB表与有限正文，解析PalmDOC和recindex；不执行电子书HTML，不全量读200MB文件进ArrayBuffer，不在解析时解码全卷。检查DRM、压缩、越界、展开大小、页数与单页限制。

## AI 图片协议

公开产品 API 统一为 `POST /v1/translation-submissions`，每项声明原图摘要、字节数、可选文件页身份；上传受理后走有限字节的上传会话。业务生成输入仍只有原图与目标语言，后端构造提示词，无重绘前置 OCR。

图片供应商适配器调用兼容 `POST /v1/images/edits`，配置 endpoint、model、image/image[]、参数白名单、尺寸和超时。密钥仅引用后端环境变量。输出 URL 进行域名、DNS/IP 和重定向检查；可解码、归属正确、持久化成功后交付。聊天接口或模型列表不构成图片编辑验收。

## 任务、权益与数据

- Job 保存内容/模式/语言/有效生成配置；Submission/SubmissionItem 保存有序用户意图和共享任务引用；UploadReservation 保存实际字节校验前的有限占位；JobRequest 保证操作幂等。
- JobStage 保存依赖和代次，ExecutionLease 保存资源执行权，FairnessState 保存真实占用时间校正的加权服务量，UserModeQueue 保存阅读会话、暂停和下一个上传空位。
- User、QuotaPeriod、MembershipOperation、Ledger 实现普通／PLUS、周期页数和限时赠送；供应商 Attempt/TextCall 成本独立计量。
- 原图以内容 SHA-256 匹配，FilePage 按用户/文件哈希/原始页索引识别。无字结果与有效译图可复用，过期、删除和跨账户结果不能复用。
- 任务状态从 awaiting_upload/validating_upload 进入 queued/running，再到 succeeded/no_text/failed/cancelled/outcome_unknown。未知期限释放后仍保留 unknown_released 成本证据，不自动重发重绘。
- 受理、排序、租约、终态和结算在一致锁顺序下事务提交。首次交付冻结结果摘要，每租约独立对象键；晚到计算和重复网络通知不能覆盖已交付版本或重复扣量。
- 账户增量游标由事务锁下的单调序列赋值，避免先分配序列、后提交造成客户端漏读。历史分页用固定查询数的数据库投影，不读整份供应商配置，不探测 R2。
- 原图/译图默认无限期保留，最近授权访问时间为后续闲置清理提供依据；活跃任务引用保护原图。常规缓存可丢弃，OCR/译文检查点持久化。详见[存储说明](OBJECT_STORAGE.md)。

## 身份与运维

生产OIDC验证JWT签名、issuer、audience、到期，浏览器授权码+PKCE并校验state。身份未配置拒绝私有操作。DEV_AUTH仅本地、随机签名密钥、127.0.0.1绑定，不能用于公开部署。

每个图片／任务／批次检查归属。删除先tombstone并撤销，任务丢弃后到输出。原图/译图默认无限期保留，仅主动删除、未来显式期限和临时孤立对象执行清理，数据库与私有 R2 保留/备份策略协调。日志只记录任务ID、错误、阶段、耗时和脱敏计量。

公开发布仍需真实OIDC、精确扩展来源、HTTPS、运营策略与保留期限、目标站点和供应商质量验收。构建、本地运行和公开部署分别报告。
