# PDF / ZIP 整本文件翻译

这是官网的账户后台任务，不改变插件的单图覆盖协议或漫画导入边界。输入为 PDF 或含图片的 ZIP / CBZ，最多 200 页、200,000,000 字节（十进制 200 MB）；输出统一为按页编号的完整 PNG 译图 ZIP。浏览器不解析 PDF、不解压、不合成译图、不打包结果。

## 交付与额度

注册账户登录后可新建文件任务，不另设付费准入；每日免费、试用、赠送、订阅与购买额度沿用现有模型适用范围、有效期和扣费顺序，游客仍需登录。已受理任务冻结模型版本，不因会员到期改换模型。实际页数由受理该文件的计算宿主验证，随后一次事务预占全部 N 页；额度不足等待用户补充，不部分执行。不限量订阅和试用按对应账期记录执行占用；不限量运营赠送没有账期或有限额度桶，其分配与结算冻结在既有 Job 权益快照和幂等账本中，不制造有限额度桶，也不改变数据库结构。

额度不足不拒绝已上传文件、不部分预占、不执行 OCR，转为 `awaiting_quota`，展示所需、当前可用和差额。用户可补额后主动继续，或在预占前取消；不会因后台额度变化悄悄重启任务。预占提交与取消使用同一调度锁，一旦 `reserved_at` 写入，取消始终返回 409 `DOCUMENT_NOT_CANCELLABLE`，包括排队、OCR、已发送 LLM、等待恢复及已完成，不依赖页面按钮实现限制。

仅完整 ZIP 发布成功后结算有译文的页；无文字页保留规范化原图、释放对应预占。失败不交付缺页 ZIP，释放用户预占，供应商实际／未知成本继续独立记录。结算写回最初分配的桶并保留幂等账本，不借用后来出现的权益。

上传中必须保留当前页面；收到 `complete-upload` 封存成功后可离开。历史在服务端按账户保存，重新登录后继续查询或下载，不依赖浏览器保存源文件。网络失败可在当前页面重试分片；刷新后需要重新选择同一文件，不承诺浏览器关闭后继续上传。

## 固定执行路径

```text
浏览器 ──分片 PUT──> 私有 R2
   └─元数据──> API ──封存──> 固定宿主 doc_prepare（源文件 GET）
                                  ├─额度不足：awaiting_quota
                                  └─全额预占：doc_ocr × N
                                               ↓ 全页检查点齐全
                                   中央 doc_text × 1（纯文本）
                                               ↓ 完整 ID 校验
                                   原宿主 doc_render × N
                                               ↓ 全部译图齐全
                                   原宿主 doc_zip → 最终 ZIP PUT → R2 下载
```

API 只接收有界 JSON、做授权、R2 分片元数据操作和 SQL 状态变更；不代理文件字节、不解压、不执行 PDFium，也不下载中间文件。OCR 原文及逐页译文以内联 JSON 经节点控制协议传递。客户端不能提交对象 key、实际页数、额度桶、供应商参数或支付权限；外部文件 IO 不持有调度锁。

首次领取 `doc_prepare` 在数据库中固定 `owner_node_id`。该宿主从 R2 流式读取并校验源文件，随后在关闭网络的受限子进程内预检与规范化：验证内容、页数、摘要、像素、维度、解压体积及磁盘预算，拒绝加密文件、路径穿越、链接、嵌套压缩容器与压缩炸弹。PDF 按顺序光栅化；ZIP 支持 PNG、JPEG、WebP、静态 GIF，自然排序后规范化为 PNG。仅忽略明确的文本元数据、隐藏文件及 `__MACOSX`；未知图片格式／扩展名整本拒绝，不默默漏页。

源文件、规范化原图、完整 analysis／掩膜、译图和待上传 ZIP 均保存在该宿主任务私有的 `state_dir/documents/{job_id}/{workspace_generation}/`，不上传中间 R2 对象。正常无重试路径只有一次源 GET、一次最终 ZIP PUT；逐页 OCR／渲染完成只提交有界文本或描述符，不逐页签名、PUT 或 HEAD。ZIP 在本地按完整页清单校验、打包，只有全部页面可交付才上传。

prepare、逐页 OCR／渲染、ZIP 各持短期阶段租约。OCR 阶段结束立即释放执行位，不占 GPU 等整本 LLM；任务目录的宿主归属不是一个长期 GPU 租约。单图与文件页的资源及领取规则见下节。

中央 `document-worker` 只执行 `doc_text`，共用 `control-document` 小池，初始 1、后台可设 1–4、可停用。API 原有上传／文本池不执行这些工作；`DOCUMENT_WORKER_SLOTS` 另限制每个文本 worker 的本地线程数，首次建池后不会覆盖管理员的全局配置。数据库有索引的有界候选查询和现有租约负责领取，暂不引入新队列服务、通用 DAG 或复杂抢占。

这些限制保护 CPU、GPU、内存及 API 通道，不等于限制已受理的队列／R2 总积压。当前没有新增每账户文件份数硬上限，仍共用现有控制请求保护；持续交互负载可能使文件任务长时间等待。启用前必须监控 R2 存储、最老文件等待和未知调用，按容量开放入口，不能把默认低并发当作存储总预算或交付时限保证。

## 共享调度与闲时借位

单图与文件页共用同一节点身份、固定的下载／计算／嵌字／交付池、GPU runtime 和内存预算，不另建文档模型进程或第二套执行池。`document_slots` 是文件任务的保守并发，默认 1、范围 0–32，有效并发仍受总 `execution_slots` 约束；0 关闭文件阶段的新领取，非零值不是闲时 OCR／译图的硬上限。

中心在现有调度锁内，以当前节点的能力、语言、协议及任务就绪条件判断普通单图是否可领取，并统计该节点的未释放租约；不把全局排队数量或 GPU 利用率当作空闲依据。到期但尚未回收的租约仍占容量。

| 普通单图状态 | 文件阶段的新领取 |
| --- | --- |
| 存在当前节点可立即领取的普通单图 | 优先普通单图，不新领文件阶段 |
| 没有可领取普通单图，但本节点仍持有普通单图租约 | 文件阶段仅使用 `document_slots` 保守并发 |
| 两者均无 | `doc_ocr`／`doc_render` 可借用总执行位内的空位；`doc_prepare`／`doc_zip` 仍受保守并发限制 |

节点的文档在途窗口为 `min(execution_slots, max_leases, local_pages + render_workers)`，其中 `render_workers` 使用启动后解析的有效值。普通与文件合计仍受中心总执行位、本地 `max_leases`、共享内存及各池容量约束；已占位从可用容量扣除，两个领取通道共用在途 claim 门，前次回执尚未接收或待恢复时不能从另一通道重复使用空位。窗口限制在途工作，不等于同时运行同一模型，也不改变现有模型锁、计算／嵌字并发与线程预算；具体本地配置见[节点配置](NODE_CONFIGURATION.md#节点本地配置)。

普通单图优先发生在新租约领取。已领取页面由共享池统一派发：普通单图内部保留抹字优先于分析的顺序，再与文件页比较两类就绪队首的等待时间，先推进较早就绪者，就绪时间相同时普通单图优先。只扫描有界在途窗口，不向执行器堆积无界队列；新到普通任务不能反复插队饿死已领文件页。

普通任务到来后停止额外补领，已领取的文件窗口自然完成；退回保守状态只约束后续领取，不抢占、暂停、取消或重跑已领页面。因此新普通任务仍可能等待当前文件窗口收尾，低优先级不保证零等待。借位不改变检测、OCR、抹字、嵌字算法，不绕过全页 OCR 汇总后唯一 LLM 的屏障，也不增加中间 R2 传输或最终 ZIP 上传次数。

## 宿主恢复与本地文件

清单、页面检查点和完成描述采用原子写入；文件长度与 SHA-256 绑定任务、页号、宿主和 `workspace_generation`。目录不接受符号链接／重解析点／硬链接；共享 spool 有字节预算，输入、PNG、analysis 与最终 ZIP 一起计入，不在内存中保留整本图片。阶段回执只释放该阶段的恢复记录，不删除整本目录。重启后同一宿主从中心同步租约和目录状态，复用已耐久保存的页面，不重新 OCR 已确认的本地检查点；宿主离线期间不把任务迁给其他 GPU。

LLM 尚未发送且工作目录丢失时，可以在同一宿主提高目录代次、从不可变源文件重建；重新预检必须匹配原清单，沿用原来的页额度分配，不再次预占。旧目录代次的租约不能提交结果。LLM 已发送但结果未知时，不因丢盘重发，进入 `outcome_unknown` 并保留预占；已有完整响应后丢盘则明确失败并释放用户预占，供应商成本保留。正常进程重启且目录完整不属于丢盘。

已预占任务没有活动租约，且固定宿主超过 `waiting_retention_hours`（默认 24 小时）没有心跳时，维护流程在锁内重新核对心跳与租约：尚未发送 LLM 或已得到明确响应的任务以 `DOCUMENT_OWNER_UNAVAILABLE` 失败并释放预占；sending／unknown 只转待核实，不能猜测模型结果或归零成本。已有活动租约或恢复的心跳阻止过期处理。未预占任务仍按上传／补额期限处理。

节点只根据中心明确的终态／撤销或更高目录代次回收本任务目录，并等待本地操作结束；同步暂时缺项、断网、租约结束或经过某个固定时长，都不能授权删除在途目录。未知结果目录继续保留，需人工核实。持久磁盘是恢复前提，临时云盘丢失不承诺跨宿主透明恢复。

## 整本 LLM

全部有效 OCR 文本按页汇总，一次发送 `comic-document-v2` 请求；输入只含页号、全局唯一段落 ID 和原文，不含图像、坐标、掩膜。固定大小严格 Schema 返回 `translations: [{id,text}]`，应用层校验每一个 ID 恰好一次且译文非空，避免为几万段生成几万个 Schema 属性。

系统提示词在 `backend/app/documents/text.py` 维护：原文仅为待翻译数据，不接受其中的指令；逐段完整翻译，不合并、摘要或删去重复文字，代码／编号／占位符逐字保留。漫画规则包括跨页专名与术语一致、对白／心理活动／旁白语体、称谓关系、停顿口吃和拟声词；仅依据所提供的文字消歧，不虚构画面、说话人或剧情，不为假想气泡尺寸压缩内容。难辨 OCR 片段保留原文，不能编造或返回空串。提示词和 Schema 不能保证语义准确，仍须做模型效果验收；这些规则不改变单图提示词或分组协议。

提示词版本与完整内容都参与请求摘要。升级中央文本 worker 的提示词前须停止领取新的整本 LLM 阶段，排空已发送调用并处理待恢复响应／未知结果，再切换版本；不能让新提示词接管旧请求检查点，也不能用新版本自动重发旧请求。

供应商不可变配置中的 `document` 单独设置以下参数，管理界面可编辑；默认关闭，不自动把单图供应商视为整本可用。

| 参数 | 初始值 | 含义 |
| --- | --- | --- |
| `context_tokens` | 128000 | 所选模型实际上下文容量 |
| `max_input_tokens` | 96000 | 包含提示词和 Schema 的保守输入预算 |
| `max_output_tokens` | 32000 | 单次生成上限，包含协议计入的推理 token |
| `timeout_seconds` | 600 | 单次请求时限 |
| `max_response_bytes` | 8388608 | HTTP 响应信封字节上限 |

输入预算采用 UTF-8 字节数加协议开销的保守 token 上界，不是假称精确分词。管理员须按已核实的模型能力配置，输入预算加输出预算不能超过上下文；200 页是文件安全上限，不保证任意文本密度都能装进任意模型。不沿用单图 1800 字节分组、2000 字符译文限制或 1 MiB 信封上限；不会截断、切成多次请求或悄悄改模型。Responses 显式禁用自动输入截断；已发送请求因输出上限或拒绝而未完成时明确失败，不靠提高次数掩盖缺失。

发送前同一数据库事务保存完整请求、输入摘要、`call_id` 与发送意图，提交成功后才发 HTTP。收到响应后，完整响应与调用状态／成本在同一事务保存，再以内联 `{analysis_hash,language,translations,revision}` 持久化各页译文。请求、响应及逐页正文列按需加载，列表和普通调度查询不自动读取；旧 `text_input_ref`／`text_output_ref` 仅保留 SHA-256、大小和 MIME 描述，不含 R2 key。

网络中断、响应无法解析、发送后响应事务失败，或尚无持久响应时租约丢失，进入 `outcome_unknown`，保留预占，不自动重发整本请求。晚到的明确成功／失败更新原调用；已落库响应可由恢复流程验证请求身份后重放到逐页检查点，不再调用模型或 R2。只有准入前明确未发送的限流／停用允许重新排队。供应商 RPM 与单图、漫画名共用，但文件 LLM 使用独立后台执行容量。

无法自动核实的调用通过管理员 `POST /v1/admin/documents/{内部 job_id}/resolve-unknown` 明确结束：提交原 `call_id`、`confirmed_no_deliverable_result: true`、核实说明，可选已核实成本；要求无在途租约，记录审计，释放预占但不发起新 LLM。未核实成本保持 unknown，不擅自归零。该操作不是用户取消。

## 代码边界

| 模块 | 负责内容 |
| --- | --- |
| `backend/app/documents/api.py`、`quota.py` | 账户隔离的用户 API、冻结模型、全额预占／结算／取消竞态 |
| `documents/models.py`、迁移 `0017_documents.py`／`0018_document_workspaces.py` | 根 Job 扩展、宿主／代次、延迟加载正文、逐页描述、多桶分配 |
| `documents/workflow.py` | 固定阶段、屏障、恢复与终态；复用 JobStage / ExecutionLease |
| `documents/worker.py` | 中央整本文本执行、未知响应核实、R2 终态清理 |
| `backend/document_files/` | 共享的受限 PDF／ZIP 解析、文件预算与完整 ZIP 校验；API 不导入解析器 |
| `documents/storage.py` | 私有 R2 分片、短期签名、不可变对象、流式哈希校验 |
| `documents/text.py` | 整本提示词、唯一调用意图、响应完整性与成本；复用渠道适配器 |
| `documents/compute.py`、`classic_node/document_runner.py`／`document_workspace.py` | v2 固定宿主协议、本地文件与恢复、低优先级阶段、源／最终 ZIP 直连 R2 |
| `documents/admin.py`、现有监控模块 | 人工核实、按任务类型查询、页号与资源池配置 |
| `backend/website/src/components/TranslationWorkbench.tsx`、`DocumentTaskRow.tsx` | 统一上传／设置／任务列表，分别显示图片与整份文件的状态和结果；按服务端权限提供操作 |
| `backend/website/src/lib/use-document-tasks.ts`、`document-api.ts` | 账户隔离的文件状态、按需传输模块、增量摘要、有限上传并发与分页服务端历史 |

官网同一入口接收图片与整份文件，共用语言和模型位置、启动入口及任务列表；混合提交只使用两条链路共同可用的模型。图片缓存清理与图片 ZIP 打包仅作用于图片记录，不删除或打包文件任务；整份文件结果仍由 R2 直接下载。文件列表每次 20 条，不加载逐页正文、缩略图或大 Blob；仅在有在途任务且页面可见时每 5 秒刷新一次，无逐页连接。

不把文件状态堆进原单图 API，不复制会员规则、LLM HTTP 实现或图像模型进程。原单图接口、结果格式和本地历史保持独立；管理统计明确“任务数”，一个文件不会被误计成一张图片。

## 性能诊断

`doc_prepare` 包含源 GET、摘要校验、受限解析／PNG 编码和本地耐久保存；`doc_render` 包含本地读取、GPU 抹字、CPU 排版／PNG 编码、检查点写入及中心确认，不包含逐页 R2 上传，不能当作纯 GPU 时间。最终 `doc_zip` 才包含本地 ZIP、整包 PUT 和中心 HEAD／确认。渲染复用 OCR 的位置、配色与蒙版，以及抹字阶段的气泡几何缓存；直接编码完整 PNG，不经过覆盖层再合成。编码器的输出摘要复用于结果冻结，保留自产 PNG 完整解码校验与本地文件完整性校验。

节点的有界日志以 `event=document_page_stage` 记录阶段，数值白名单包含 prepare、package、persist、计算、排队、签名、GET、PUT、完成确认耗时和调用／重试次数；时间单位为秒，`*_attempts`／`*_retries` 为次数。`stage=uploaded` 仅用于最终 ZIP，表示上传响应已返回，不表示中心已确认任务完成。冻结结果在私有恢复日志顶层保存已有计时，重启继续交付时可保留先前计算记录；诊断数据不进入完成请求或结果摘要，不能改变幂等身份。普通计算异常以受控阶段错误码报告，不因记录异常而中断共享节点。

中心沿用 Uvicorn 的 INFO 日志输出 `document_compute_complete`，记录 `head_ms`、`lock_wait_ms` 和 `total_ms`：前者包含存储实例获取及 HEAD 校验，后者为路由函数内总墙钟，不含认证依赖或网络传输。仅最终 ZIP 完成检查一个 R2 对象；HEAD 前释放事务，之后重新加锁核实租约，已完成的相同请求直接返回回执。OCR／渲染只校验内联契约与文件描述，不读 R2。各细分时间包含在所属阶段内，不重复相加；日志仅保存任务／租约标识、固定阶段和数值，不记录图文、对象 key、签名地址、令牌或原始异常消息。

## R2、部署与生命周期

使用专用私有桶或既有私有桶内的专用 `DOCUMENT_R2_KEY_PREFIX`。新任务只写 `input/{job}/` 和 `output/{job}/`；不写 `work/`。源／最终对象的数据库描述保存 key、SHA-256、大小与 MIME，签名 URL 不入库、不入默认日志。浏览器签名仅允许本任务的分片 PUT；封存后分片不可再改写，宿主读取时验证实际 SHA-256，ETag 不当作内容摘要。

生产配置见根 `.env.example`。API 与负责终态清理的中央 worker 共用 `DOCUMENT_*` R2 配置；GPU 代理只获得短期、限定对象的签名，不拿 R2 密钥或 LLM 密钥。浏览器到 R2 不携带账户 Bearer，使用 `credentials: omit`、不发送 Referer。配置精确官网 origin 的 GET/HEAD/PUT CORS、所需请求头，并让官网 CSP `connect-src` 允许该 R2 S3 origin。CORS 不提供对象授权，签名仍须保密。[R2 签名规范](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)、[CORS 规范](https://developers.cloudflare.com/r2/buckets/cors/)

源下载复用领取／同步返回的有效签名，到期或传输重试才刷新；有效期从请求发出时的单调时钟保守计算。最终 PUT 由中心冻结精确描述后签发，拒绝覆盖另一内容。R2 403 只允许一次重新签名，网络重试仍受原阶段截止约束。对象传输使用不带中心凭据的独立 HTTPS 客户端，不跟随跳转；签名只在内存中使用。API／维护进程按当前配置复用 R2 客户端连接池，配置切换不提前关闭在途客户端。

Python 提供本地静态页面时，启用文件通道会仅在翻译页的 CSP 加入配置的 R2 origin。生产静态发布需在 `scripts/prepare_static_release.py` 的原有 website 命令追加 `--document-r2-origin https://<account>.r2.cloudflarestorage.com`，与 `DOCUMENT_R2_ENDPOINT_URL` 一致，不带末尾斜杠或路径；其他页面和管理后台不放宽。未添加此精确来源时，浏览器会拒绝直传。

原始上传默认 1 小时内完成，封存后未预占任务默认保留 24 小时，过期明确失败。预占后的在途任务和 `outcome_unknown` 不按上传期限删输入。终态 R2 输入／失败输出默认延迟 1 小时清理，覆盖短期签名及迟到上传窗口；成功 ZIP 默认保留 7 天，过期不可下载。回收按 job 精确前缀、批量有界进行，保留旧终态 `work/` 一次清理能力；清理不能破坏仍有效的租约。R2 应配置只清理未完成 multipart 的生命周期兜底，不对活跃输入设置固定天数删除规则。

中央文本 worker 使用 [Dockerfile.document](../backend/Dockerfile.document) 和 [独立 Compose](../deploy/compose.document.yaml)，通过与 API 相同的 `INFRA_NETWORK` 加入已有基础设施网络，连接同一 PostgreSQL、Redis 数据库编号与 `REDIS_NAMESPACE`；不创建数据库、Redis、网络或 API 结果卷，不执行 PDFium、不需要图片 spool 或 GPU，也不代理源文件与 ZIP。`DOCUMENT_ENABLED=true` 时，集群健康检查额外要求健康的文本 worker 与已注册文件协议 v2、配置已生效且文档槽位未关闭的在线节点；API 自身就绪检查仍不依赖后台容量。宿主节点使用共享解析包、PDFium、Linux Landlock（ABI ≥3）和 libseccomp，启动时真实验证解析子进程的文件与网络边界，不依赖用户命名空间；不支持的平台不得声明 `document_protocol:2`。限制只作用于处理不可信文件的子进程，节点主进程正常联网。统一安装与预检见 [Linux 节点部署](../services/compute-node/linux/README.md)，不使用 privileged、SYS_ADMIN 或 unconfined。

运维另行创建私有 `deploy/.env.document`（数据库、统一 Redis、身份及 DOCUMENT 配置）；用不可变镜像启动。宿主的 `state_dir` 使用持久磁盘及硬配额，`document_spool_bytes` 默认 6 GiB，和中心下发的文件预算取较小值；不以 tmpfs 承载整本文件。必须在目标宿主核实沙箱、磁盘预算、共享单图资源与重启恢复，再开启入口和供应商 `document.enabled`。未知目录交由运维核实，不粗暴清空 state_dir。

数据库版本为 `document_workspaces_0018`，在 0017 的阶段唯一键、多桶约束和 bigint 调用成本基础上增加固定宿主、目录代次及完整文本请求／响应。0018 遇到任何旧版非终态文档即拒绝迁移，不能靠升级取消任务、释放预占或重发未知调用。先用旧版本停止受理并排空／人工核实全部旧任务，再备份并按[部署规范](DEPLOYMENT.md#迁移与兼容性)迁移，配套更新 API、控制／维护进程、文本 worker 与计算节点；v1／v2 不能混跑，也不转换旧 R2 中间检查点。回滚需一致备份，不支持直接 downgrade。功能默认关闭，不在构建或测试时自动部署、改桶策略或接入生产任务。

## 本地真实联调

[本地启动器](../backend/tests/manual_document_live_server.py)只连接独立 PostgreSQL `127.0.0.1:54329/nodecomics_document_local`（用户 `document_local`）与 Redis `127.0.0.1:6389/0`，不复用原有 `18088` 栈或生产库。启动前关闭两类 Settings 的隐式 dotenv 继承，并核对数据库实际身份；API 才能迁移和初始化，其他角色只检查现有库。

在忽略的私有目录（例如 `artifacts/document-local/`）准备 `runtime.env`：`DATABASE_URL`、`REDIS_URL`、规范 UUIDv4 `DOCUMENT_RUN_ID`、至少 32 字符随机 `DEV_AUTH_SECRET`，以及位于该目录下且互不包含的绝对路径 `STORAGE_PATH`、`DOCUMENT_SPOOL_PATH`。可额外设置 `DOCUMENT_LOCAL_DB_PASSWORD` 供 Compose 使用，须与 URL 中密码相同。另准备 `providers.private.json`，内容为真实 `ProviderWrite` 数组（连接配置、模型、协议、路由、套餐范围及密钥），不得提交或写入日志。供应商只在本地开启 document 能力，不更改线上配置；已提供的文件输入／输出预算保留，未提供的使用 `DocumentTextPolicy` 默认值。

仓库根目录先启动专用持久化数据服务，再在独立终端分别运行后端角色与网页：

```powershell
docker compose --env-file artifacts/document-local/runtime.env -f deploy/compose.document-local.yaml up -d --wait
backend/.venv/Scripts/python.exe backend/tests/manual_document_live_server.py --env-file .env --runtime-env-file artifacts/document-local/runtime.env --providers-file artifacts/document-local/providers.private.json --role api
backend/.venv/Scripts/python.exe backend/tests/manual_document_live_server.py --env-file .env --runtime-env-file artifacts/document-local/runtime.env --role maintenance
npm.cmd --prefix backend/website run dev:documents
```

浏览器入口 `http://127.0.0.1:5195/`，API 仅监听 `127.0.0.1:4324`。启动器只读取指定根文件的 `R2_*` 字段，在既有前缀下创建本轮独立子前缀。浏览器仍直连 R2，须保留原规则并允许精确本地 origin 的 GET/HEAD/PUT；启动器不自动修改桶。原生开发登录只在专用 Vite 入口适配，正式 OIDC 规则不放宽；两个测试账户 `document-local-paid`、`document-local-other` 各预置 2000 页购买额度，不进行支付，重启不补回已消费额度。

完整处理还需同一数据库／Redis／R2 前缀的 `document-worker` 处理全文，以及以独立身份连接本地 HTTPS 控制面的 Linux GPU 宿主。解析沙箱随宿主节点探测：Windows 或缺少所需 Landlock 能力的平台不能声明文件 v2 能力；禁止用户命名空间本身不再是阻碍。只测文件任务无需单图 `app.workers`，但仍保留 maintenance；缺少合格文件宿主时停在预检排队，缺少文本 worker 时停在全文阶段，不伪造成功。GPU 只拿节点令牌和短期对象签名，不下发 R2／LLM 密钥。测试网络、磁盘硬配额和解析边界须分别注明验证范围，不把本机功能联调称为生产部署验收。

停止前先停止接收新任务并排空已发送 LLM／有效租约，再停止相应进程与 Compose；`docker compose ... down` 保留数据卷，不使用 `down -v` 清除仍有任务的数据库。私有运行文件、节点身份和 R2 子前缀必须与数据库一起保留，避免失去恢复能力。

## 验证入口

在 `backend` 执行 `python -m pytest -q tests/test_document_*.py`；测试涵盖授权、200 页边界、多桶原子预占、取消竞态、重复结算、文件恶意结构、固定宿主与代次、共享 GPU 容量、LLM 数据库断点与未知调用不重发、完整 ZIP 和清理。节点测试见 [test_document_node.py](../services/classic-engine/tests/test_document_node.py) 和 [test_document_workspace.py](../services/classic-engine/tests/test_document_workspace.py)，验证本地检查点、无中间对象传输及恢复。PostgreSQL 并发用 `RUN_POSTGRES_CONCURRENCY=1` 和明确隔离的 `nodecomics_concurrency_test` 数据库；普通 fixture 不代表 GPU／模型效果。

真实 R2：仓库根运行 `backend/.venv/Scripts/python.exe scripts/verify_document_storage_live.py --help`，使用指定凭据和随机测试前缀，验证后只清理自身对象。真实模型：`scripts/verify_document_llm_live.py --base-url <私有兼容接口>/v1 --model <已授权模型> --protocol responses`，或通过 `--profile <不含密钥的配置.json>` 保留实际协议、思考参数和上游路由；密钥独立从隐藏输入或 stdin 读取，不改生产供应商。默认一次发送合成两页文本；`--case pages-200` 验证 200 页、全部段落 ID、首尾编号和超过 2000 字符的单段译文，实际 POST 次数由传输层计数。`--case comic-context` 增加跨页专名、数字、代码、对白片段、拟声词和伪指令样本；只自动校验结构与字面保留，报告中的 `semantic_review` 保持待评审，否定作用域、同音词消歧和漫画自然度须另行人工查看合成译文，不能将关键词检查当成准确率。脚本记录提示词版本及结果元数据，不记录正文或凭据。独立预算可用 `--max-output-tokens`、`--timeout-seconds`、`--context-tokens` 等测试参数指定，但不得超过已核实的模型能力。模型列表成功不等于账户有推理权限；这些合成文本检查也不替代真实 OCR、绘图或模型质量验收。
