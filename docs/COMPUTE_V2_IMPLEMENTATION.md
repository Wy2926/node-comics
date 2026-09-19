# 整页计算 v2 实施与切换

2026-09-19 本地实现。计算端为 [classic-engine](../services/classic-engine/README.md)，中心路由为 [compute_v2.py](../backend/app/compute_v2.py)。已启动[本机真实服务](CLASSIC_LOCAL_RUNTIME.md)，使用真实 R2 和在线文本模型；没有修改 VPS 数据库或切换公开生产服务。

## 持久化与切换

迁移 `shared_0006_compute_v2` 新增 `compute_claims` 和 `execution_leases.limits`，不删除或转换已有任务、资产或额度记录。中心正常启动的 Alembic 入口执行迁移。新常规配置快照包含 `engine.protocol_version=2`，生成 `page` 与 `text` 两项持久工作；只有 `page` 对图像节点开放。原三阶段图像 API 只供升级前任务排空，不把 v2 租约转为旧协议，也不允许从旧 complete 接口交付 v2 结果。

升级时先停止受理新的常规任务并排空旧图像租约，再部署中心和新节点、设置实际引擎版本、恢复常规入口。不要自动清库、删除旧任务或把正在执行的页改成新算法。登记 v2 时遇到未释放的旧阶段租约会拒绝切换。保留旧阶段代码是为了原有任务及旧代理的排空，后续可在确认排空后删除；新节点不包含旧引擎适配层。

中心复用既有调度事务锁和公平选择，每批每分配一页都重新选举；同节点多个并发 claim 仍按全部未释放租约计数，过期但未回收的租约继续占位。`page` 公平计量包括领取、等待文本、交付及回收前的名额占用时间，不能理解为 GPU 用时。普通／PLUS 在途上限、文本供应商限流及一次结算逻辑保持独立。

## 具体消息

所有路径以前缀 `/internal/compute/v2` 开始，请求头携带 `Authorization: Bearer <node_token>` 与 `X-Node-Id`。控制 URL 和 R2 URL 的客户端隔离；节点对 R2 不发送控制凭据。摘要统一为 UTF-8 编码的 `json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':'))` 的 SHA-256；图片摘要直接散列原始字节。禁止 NaN／Infinity。

| 操作 | 请求字段 | 主要响应 |
| --- | --- | --- |
| `POST /nodes/register` | `protocol_version:2`、`engine_version`、`resource_id`、`device`、`supported_languages`、`ready` | `protocol_version`、`server_time`、`config`、该身份未释放的 `leases` |
| `POST /nodes/{id}/claim` | `request_id`、`config_version`、`count`（1–32） | 原 `request_id`、`server_time`、`config`、`leases` |
| `POST /nodes/{id}/heartbeat` | `config_version`、`leases:[{lease_id,lease_token,translations_revision,phase}]` | `server_time`、`config`、逐项续期／停止／终态回执；译文有更新才返回正文 |
| `POST /leases/{id}/analysis` | `lease_token`、`analysis_hash`、`analysis` | `analysis_hash`、`receipt`；有文字时为 null，无文字时为稳定终态 |
| `POST /leases/{id}/input/authorize` | `lease_token` | 新下载授权和输入元数据，绝不返回图片字节 |
| `POST /leases/{id}/complete` | `lease_token`、`result` 或 `error:{code}`，二选一 | 稳定 `terminal` 回执 |

活动 lease 包含 `lease_id`、`lease_token`、`job_id`、`generation`、`status:active`、`expires_at`、`limits`、`input`、`config.engine`、`language`、已有 `analysis`／`analysis_hash`／`translations`。`input` 包含 `url`、`url_expires_at`、`server_time`、`sha256`、`byte_size`、`mime`、`width`、`height`。GET 授权最多 60 秒，且早于已确认租约截止；签名不访问远端对象。每次授权、成功心跳记录原图授权访问时间。

译文包为 `{analysis_hash, language, translations:{segment_id:text}, revision}`，`revision` 是前三项组成对象的摘要。只有 text 工作成功后才发送完整译文；节点等待期间每 1 秒批量心跳，其他时间默认 10 秒。最终 `result` 在原图片合约基础上新增 `analysis_hash` 与 `translations_revision`，必须绑定当前分析和完整译文。

分析的 `regions` 保留 manhua-engine 的分组几何和排版参数，同时提供中心要求的四点 `lines`；`segments` 按相同顺序提供唯一 ID 和原文。无文字为两个空列表与 null mask。分析不超过 4 MiB，最终 PNG 与两张 PNG 掩膜按中心现有上限校验；中心恢复原图 alpha 并验证两掩膜并集外 RGB 不变后，写入不可变内容对象再确认终态和结算。

`status:stop` 携带固定 `code`；节点必须先停止／排空本地工作，再用 `error:{code:LEASE_STOPPED}` 确认。已结束 lease 返回 `status:terminal`，包含 `outcome`、`job_status`、`result_hash`、`completed_at`。一个失效／错误令牌不影响同批其他租约。

节点失败仅上传固定代码，不上传原始异常或图片文字。允许的错误包括 `ENGINE_UNAVAILABLE`、`CLASSIC_LOCAL_INTERRUPTED`、`INPUT_INVALID`、`INPUT_HASH_MISMATCH`、`STORAGE_AUTH_FAILED`、`STORAGE_UNAVAILABLE`、`CLASSIC_ANALYZE_FAILED`、`CLASSIC_INPAINT_FAILED`、`CLASSIC_RENDER_FAILED`、`ENGINE_VERSION_MISMATCH`、`TEXT_DEADLINE_EXCEEDED`、`DELIVERY_DEADLINE_EXCEEDED`、`PAGE_DEADLINE_EXCEEDED` 和 `LEASE_STOPPED`。

## 配置、幂等与恢复

v2 `config` 仅下发版本、启停、`execution_slots`、`poll_seconds`、`heartbeat_seconds`、`waiting_heartbeat_seconds`、`request_seconds`、`page_seconds`、`text_wait_seconds`、`delivery_seconds`、`allowed_languages`。管理配置结构暂与旧阶段节点共用，旧 `engine`／线程／缓存／阶段字段不发送给 v2 节点，也不控制其执行。新节点表单只显示 v2 参数。

整页处理时限默认 900 秒，首次分析后的文本等待默认 600 秒，首次结果交付后的重试窗口默认 120 秒；中心把有效期限制在最早截止之前，心跳不能无限占位。每个 lease 保留接单时限快照，普通配置调整直接约束后续领取，既有页继续完成；恢复次数使用现有 `CLUSTER_STAGE_ATTEMPTS`。文本首次调用的处理时限和自动重试仍由中心独立管理。

节点先持久化 claim 编号，再请求中心；同编号不同内容冲突，已回收编号返回终态，空回执也被保存。中心当前保留 claim 回执，不自动清理它们。分析重复不会重新开放 text；恢复页复用已经持久化的分析、运行中的 text 和成功译文。image 与 text 有各自的代次，节点失联不重复已完成文本计量。

结果在网络请求前冻结到本地日志，在中心写对象前冻结其摘要。同结果重交返回原回执，不同结果冲突。对象已写入而终态事务中断时，维护进程按冻结的不可变内容键恢复交付；迟到的旧代次不能覆盖新代次。没有可恢复产物时按有界恢复规则重新领取，抹字图无需跨节点保存。

## 本地验证边界

测试入口：[中心协议](../backend/tests/test_compute_v2.py)、[实际节点客户端联调](../backend/tests/test_compute_node_v2.py)、[PostgreSQL 对照](../backend/tests/test_compute_v2_postgres.py)、[节点安全与恢复](../services/classic-engine/tests/test_node_transport.py)。覆盖并发容量、公平逐页分配、领取／分析／交付丢响应、串行与双页本地执行、缩容停用、空白页、取消、截止时间、重启冻结结果、文本复用、已写对象恢复、R2 origin 与凭据隔离。

隔离 Vulkan 测试使用英文／日文生成样张；检测、OCR、AOT 与嵌字真实执行，中心进行图片验收。该组测试的 LLM 为固定回复、对象存储为测试适配器。后台完成真实浏览器创建节点、4 执行位及表单／JSON 切换检查。后续已另行通过真实 R2 与在线 `gpt-5.6-luna` 完整交付，见[本机运行记录](CLASSIC_LOCAL_RUNTIME.md)；Linux／NVIDIA 和公开部署未验收。

2026-09-19 验证记录（各组有重叠，不合计）：

| 检查 | 结果 |
| --- | --- |
| 完整后端测试 `pytest backend/tests -q` | 546 通过、100 按环境条件跳过 |
| 节点及迁入算法测试 | 61 通过 |
| 独立 PostgreSQL 上的 v2、调度、并发恢复测试 | 43 通过 |
| 实际节点客户端联调（含两张真实 Vulkan 样张） | 5 通过 |
| 管理后台类型检查、构建、单元测试 | 检查与构建成功，5 项测试通过 |
| 隔离后台浏览器操作 | 创建节点、4 执行位、JSON 切换、语言校验及配置保存通过 |

PostgreSQL 使用临时容器和独立 schema，后台使用临时数据；验收后已停止这些服务。真实图片结果及脱敏报告在本机被忽略的 `services/classic-engine/artifacts/v2-smoke/`，不作为新的吞吐基准。
