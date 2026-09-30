# 总中心与计算节点协议

本文描述仓库中的 **v3 整页计算协议**。中心实现为 [compute_v3.py](../backend/app/compute_v3.py)，节点为 [classic-engine](../services/classic-engine/README.md)。部署需配套更新中心、节点和客户端；旧节点协议不提供兼容入口。AI 重绘仍由中心独立执行池处理。

## 职责与执行位

中心负责受理、有限候选内的简单会员优先分配、租约授权、文本调用、持久检查点和一次结算；可信自管节点负责检测、OCR、抹字、固定字体嵌字及无损覆盖输出。节点质量声明不等于中心已验收模型效果。

`execution_slots` 是未释放整页租约数，下载、等待文本、交付均占租约；GPU 计算并发由节点的 `local_pages` 控制。新 claim 每批最多分配 4 页，并发 claim 和到期未回收租约均计入容量。缩容、停用只限制新领取；取消要求停止本地工作并确认。配置默认值与语言能力见[节点配置](NODE_CONFIGURATION.md)。

```mermaid
sequenceDiagram
    participant N as 图像节点
    participant C as 中心与文本池
    participant F as 中心私有磁盘
    N->>C: 注册、claim 整页租约
    C-->>N: 当前租约、相对输入路径、摘要、检查点
    N->>C: GET input，节点身份 + 租约令牌
    C->>F: 读取任务临时原图
    C-->>N: 有界图片字节
    N->>C: analysis 幂等检查点
    Note over N,C: 中心翻译文本，节点并行抹字
    N->>C: 独立 updates 长轮询
    C-->>N: 持久译文或停止状态
    N->>N: 嵌字，冻结覆盖文件与完成描述
    N->>C: 一次 PUT result，metadata + output
    C->>F: 耐久发布不可变结果
    C->>C: 复核租约与摘要，提交成功和一次结算
    C-->>N: 稳定终态回执
    Note over N,C: 中心清理临时原图，节点清理冻结结果
```

## 传输与信任边界

所有路径以前缀 `/internal/compute/v3` 开始，携带 `Authorization: Bearer <node_token>` 和 `X-Node-Id`。中心使用 HTTPS；节点只接受当前租约的精确相对输入路径，不接受外部 URL、任意跳转或源站凭据。原图、覆盖文件都通过中心传输，不签发下载/上传 URL，不使用对象存储客户端、MD5 或 ETag 上传确认。

原图 GET 额外携带 `X-Lease-Token`，中心核对节点、租约令牌、代次、取消状态和期限后直接返回字节。已经开始的流式读取有界完成或被客户端中断；取消立即阻止后续读取和交付，不能召回已经下载的字节。节点验证长度与 SHA-256，缓存不延长执行权。

JSON 摘要为 UTF-8 编码的 `json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':'), allow_nan=False)` 的 SHA-256；文件摘要直接散列字节。默认日志不写图片、OCR 全文、令牌或原始异常。

## 消息

| 操作 | 请求 | 响应 |
| --- | --- | --- |
| `POST /nodes/register` | `protocol_version:3`、引擎版本、资源 ID、设备、语言、ready | 协议版本、server_time、config、该身份未释放的 leases |
| `POST /nodes/{id}/claim` | request_id、config_version、count（1–32） | 原 request_id、server_time、config、leases；新分配最多 4 页；空批可带短退避提示 |
| `POST /nodes/{id}/updates` | revision、wait_seconds（0–20）、config_version、can_claim、最多 32 项 leases 快照 | revision、claim_ready、变化的 leases；配置变化时带 config；不续租、不领取 |
| `POST /nodes/{id}/heartbeat` | config_version、leases 中的 lease_id、lease_token、translations_revision、phase | server_time、config、逐项续期／停止／终态；只返回更新的译文 |
| `POST /leases/{id}/analysis` | lease_token、analysis_hash、analysis | analysis_hash、receipt；有文字时 receipt 为 null，无文字时为稳定终态 |
| `GET /leases/{id}/input` | 节点头与 X-Lease-Token | 原图二进制；不跳转、不签名 |
| `PUT /leases/{id}/result` | multipart：一个 metadata 字符串字段、最多一个 output 文件 | 稳定 terminal 回执本体 |
| `POST /leases/{id}/complete` | lease_token、error:{code}，可带 timings | 错误或停止确认的稳定 terminal 回执；不接受结果图片 |

`error.code` 为 1–60 位大写字母、数字或下划线，首位必须为字母；不要求中心枚举节点诊断码。中心仅对停止确认、临时故障重试等已有调度码执行特殊逻辑，其他码作为通用失败结束并释放预占额度，保留原码供后台和客户端展示。错误负载不接受任意异常正文。新增诊断码无需再次升级中心；从严格枚举的旧中心升级时须先发布中心再更新节点。

活动 lease 含 lease_id、lease_token、job_id、generation、status:active、expires_at、limits、input、config.engine、language，以及已有 analysis／analysis_hash／translations。输入描述固定为：

```json
{
  "path": "/internal/compute/v3/leases/<lease-id>/input",
  "sha256": "<实际送译字节摘要>",
  "byte_size": 12345,
  "mime": "image/png",
  "width": 1600,
  "height": 2400,
  "normalization_version": 1
}
```

输入必须已规范化为静态单帧和 sRGB：EXIF 方向为 1／缺省；带 ICC 的源图必须先完成颜色转换，再移除 ICC，节点拒绝仍带 ICC 的输入。节点不变换已绑定摘要的输入。当前节点接受 PNG、JPEG、WebP，最多 2400 万像素、单边 8192；中心另执行请求实际字节上限。

analysis 的 regions 保留分组几何和排版参数，并提供四点 lines；segments 按相同顺序提供唯一 ID 和原文。无文字为两个空列表与 null mask。整个分析不超过 4 MiB；只有有界 mask 检查点仍用 PNG base64，不携带完整原图或译图。相同分析重复提交不会重新打开文本任务。

译文为 `{analysis_hash, language, translations:{segment_id:text}, revision}`，revision 是前三项组成对象的摘要。只有 text 成功后才发送完整译文。updates 增量为 `{lease_id,status:active,translations}`，不带输入或 expires_at；相同 revision 不重发正文。长轮询不延长执行截止，迟到的活动响应不能恢复已停止页面。

## 覆盖结果与一次提交

节点在原图 RGB 上完成抹字和嵌字，以最终 RGB 与原图逐像素差异计算变化范围，包含背景、字形、描边和抗锯齿，不能只使用 OCR mask。忽略原图 alpha 为 0 的隐藏 RGB，裁剪到最小整数 bbox；变化位置保存最终 RGB、alpha=255，其余为透明。alpha 表示像素替换，不再对字形抗锯齿做软混合。文件是单帧无损 RGBA WebP，不使用有损或 near-lossless 编码，去除无关元数据；格式依据见 [WebP 编码参数](https://developers.google.com/speed/webp/docs/cwebp)。

无字通过 analysis 完成，公开结果为 `kind=no_text, representation=original`。有文字且嵌字校验成功但可见差分为空时，通过 result 提交 `representation=original` 元数据，不附 bbox 或文件，中心记录 `kind=translated`。检测或嵌字失败不能伪装成成功。

规范化、原图身份、客户端合成与缓存统一见[翻译契约](READING_TRANSLATION_CONTRACT.md#4-状态与结果)。

metadata 是 JSON 文本：

```json
{
  "lease_token": "<当前租约令牌>",
  "result": {
    "version": "<引擎版本>",
    "input_hash": "<送译摘要>",
    "analysis_hash": "<分析摘要>",
    "translations_revision": "<译文版本>",
    "representation": "overlay-v1",
    "normalization_version": 1,
    "width": 1600,
    "height": 2400,
    "bbox": {"x": 80, "y": 120, "width": 1300, "height": 1900},
    "output": {
      "sha256": "<WebP字节摘要>",
      "byte_size": 48320,
      "width": 1300,
      "height": 1900,
      "mime": "image/webp"
    }
  },
  "timings": {}
}
```

result 的 width/height 是整页尺寸；output 的尺寸必须等于 bbox，bbox 不得越界。original 的 bbox/output 均为 null，并省略 output 文件。metadata 最多 64 KiB，output 受中心 `cluster_max_result_bytes` 约束，与原图 `max_upload_bytes` 分开；节点编码和传输上限为 88 MiB，与中心默认值一致。这是单文件协议限制，不作为磁盘容量准入。未知字段、多余文件或重复字段均被拒绝。timings 不参与 result 摘要。

中心先冻结提交摘要和交付意图，在调度锁外检查文件长度、SHA-256、解码尺寸和二值 alpha。校验完成后再次检查租约及最早截止，在短事务中持久化受理时间与截止快照，然后耐久发布文件。最终事务与崩溃恢复共用同一规则：必须有及时受理记录、当前执行代次、对应分析/译文版本且未取消，才能提交 Job 结果描述、产物关联、任务成功、一次结算和稳定回执。无文件 original 也必须完成请求校验后才能受理。恢复与清理规则以[文件存储](OBJECT_STORAGE.md#文件发布与恢复)为准。

节点在发请求前，以同一 SQLite 事务将 completion JSON 和覆盖字节 BLOB 写入本地恢复数据库；不存结果 base64，也不另建文件确认流程。响应丢失时重交相同描述与二进制，中心返回原回执。只保留未完成领取和未确认租约，终态后同事务清除记录与字节，SQLite 自动回收空闲页；不为恢复数据库设置容量领取门槛，也不按时间清除未确认交付。同租约不同摘要冲突，旧代次不能覆盖新结果。中心文件已耐久发布而最终事务未提交时，maintenance 可复核当前代次恢复交付，不重新调用文本模型。

无字仍通过 analysis 的终态回执完成。stop 携带固定 code；节点排空本地工作后发送 `error:{code:LEASE_STOPPED}`。terminal 含 lease_id、outcome、job_status、result_hash、completed_at。一个错误令牌不影响同批其他租约。失败只传固定代码，不传异常正文；允许代码以 [NodeError](../backend/app/compute_v3.py) 为准。

## 构建与兼容性

`protocol_version:3` 同时约束输入、分析检查点与覆盖结果结构。`engine_version` 和 analysis/result 的 `version` 是实际构建指纹，仅用于追溯，不参与任务路由、输入缓存键或跨节点恢复判定。中心的任务 engine 配置仅包含 `protocol_version:3`，不配置默认构建版本。

兼容节点可以接续其他构建保存的分析和成功译文；原分析及其摘要保持不变，不重新 OCR 或重复调用文本供应商。提交仍验证输入摘要、分析摘要、译文版本、尺寸、租约身份及当前执行代次。不兼容的检查点结构必须升级协议，不能仅沿用 v3 标签。

## 配置、幂等与恢复

节点先持久化 claim 的 request_id、config_version 和 count，未知结果重放原内容；全部返回租约落入日志后才清除请求。同编号不同内容冲突，空回执也保存。非空批后仍有余量可立即补领；空批等待 poll_seconds、新就绪提示或资源释放。中心在候选查询前预查回执、配置和容量，进入调度锁后复核。

并发竞争导致候选失效时，中心提交并释放锁后最多重选一次；最终空批仍有可领取工作时可附 0.1–0.3 秒随机退避提示。提示不分配、不预留执行权，不改持久回执。

整页时限默认 900 秒，首次分析后文本等待 600 秒，首次冻结结果交付意图后交付窗口 120 秒；以最早截止为准，心跳不能无限延长。既有租约使用领取时快照，中心配置只控制执行位、轮询和期限，本地模型与线程由节点配置。节点失联后可从中心临时原图重建，复用已持久化分析和成功译文；原图丢失进入同请求补传，不能重复计费。

multipart 请求体接收受 `upload_body_timeout_seconds` 总时限约束，持续发送少量字节也不能延长；超时关闭临时文件并返回 408。及时受理后，中心为本地落盘保留固定宽限：取受理前租约到期与受理时间加该总时限的较晚值；心跳和重放不延长它。宽限不授权节点继续计算，只避免维护程序在已校验文件尚未落盘时抢先重试。处理截止后落盘仍可成功；没有及时受理记录的文件不能通过维护恢复发布。

## 分阶段流水线与通知

节点使用独立下载、分析提交、计算和交付池；等待文本、传输和回执不占计算线程。heartbeat、claim、updates 各最多一个在途请求。PostgreSQL NOTIFY 仅唤醒，持久状态从数据库重读；订阅后复查、5 秒内部重查及最长 20 秒响应负责断线补偿。

无关全局通知不立即结束长轮询；配置、租约集合、具体租约或真实可领取状态变化可触发增量。claim_ready 只是提示，节点忽略早于最新领取尝试的旧提示。中心文本、重绘和上传恢复池继续独立有界，调度规则见[集群设计](TRANSLATION_CLUSTER_DESIGN.md#按就绪顺序领取)。

## 验证边界

回归入口：[中心](../backend/tests/test_compute_v3.py)、[长轮询](../backend/tests/test_compute_updates.py)、[节点联调](../backend/tests/test_compute_node_v3.py)、[PostgreSQL](../backend/tests/test_compute_v3_postgres.py)、[节点调度](../services/classic-engine/tests/test_node_scheduling.py)、[节点传输](../services/classic-engine/tests/test_node_transport.py)。

模拟文本和隔离中心验证协议、并发、丢回执、终态清理及恢复；真实 GPU 的检测/抹字/覆盖像素、真实文本服务、公网吞吐与目标机 Windows 服务另行验收。通过本地单一样图不能推断所有页面的压缩率或翻译效果。
