# Node Comics 后端

当前实现包含常规翻译 `classic` 与图片模型重绘 `redraw`。[常规翻译运行说明](../docs/CLASSIC_IMPLEMENTATION.md)包含独立 Docker 引擎、文本配置、检查点、费用预占及验证命令。`redraw` 是 API 中保留的模式标识；图片与目标语言直接送入服务端的 `images/edits` 适配器，没有 OCR 或普通机翻前置步骤。

## 本地运行

需要 Python 3.11、PostgreSQL 16+、Redis 7+。推荐使用仓库 Docker Compose，API 映射到 `http://127.0.0.1:18088`；私有图片目录使用持久化卷，不能直接映射为静态站点。

在 `backend/` 下安装和启动：

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 18088 --no-access-log
```

另外两个独立进程运行：

```text
celery -A app.workers.celery_app worker -Q redraw --concurrency=2
python -m app.dispatcher
```

Celery 推荐在 Docker Linux 容器内运行。API 和 dispatcher 启动时运行 Alembic 迁移；PostgreSQL advisory lock 保护多进程同时启动。SQLite 仅用于隔离的契约和状态测试，生产状态以 PostgreSQL 为准。

## 环境配置

| 变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | 如 `postgresql+psycopg://用户:密码@postgres:5432/nodecomics` |
| `REDIS_URL` | 如 `redis://redis:6379/0` |
| `STORAGE_PATH` | API/worker/dispatcher 共用的私有文件卷 |
| `DEV_AUTH` / `DEV_AUTH_SECRET` | 本地测试登录显式开启，签名密钥至少 32 字符 |
| `DEV_ADMIN_USERNAME` | 开发管理员用户名，默认 `admin`，仅限本地开发 |
| `OIDC_ISSUER` / `OIDC_AUDIENCE` / `OIDC_JWKS_URL` | 正式账号 JWT 校验，生产缺失时拒绝认证 |
| `OIDC_CLIENT_ID` / `OIDC_AUTHORIZATION_ENDPOINT` / `OIDC_TOKEN_ENDPOINT` | 提供给插件 PKCE 登录流程的公开配置 |
| `OIDC_ADMIN_ROLE` | 已验证 JWT `roles` 数组中的运营角色，默认 `node-comics-admin` |
| `CORS_ORIGINS` | 允许的本地阅读器地址，逗号分隔；生产仅明确列出的源 |
| `EXTENSION_IDS` | 生产允许的 Chrome 扩展 ID，逗号分隔；开发模式可用任意本地扩展 ID |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` | 默认图片编辑供应商，Base URL 自带 `/v1` 等版本前缀 |
| `OPENAI_USER_AGENT` | 默认供应商 User-Agent，针对已验证的网关兼容性配置 |
| `PROVIDERS_JSON` | 多供应商配置数组，不含密钥明文，以 `credential_ref` 引用环境变量 |
| `ALLOW_PRIVATE_PROVIDERS` | 隔离测试中的内网供应商开关，默认关闭；结果下载始终禁用内网 |
| `INITIAL_QUOTA` / `REDRAW_COST` | 新用户测试额度、每成功页面版本的测试点数，默认 100 / 8 |
| `RETENTION_DAYS` / `UNKNOWN_RELEASE_SECONDS` | 图片保留天数、结果不明预占释放期限，默认 7 天 / 3600 秒 |
| `MAX_UPLOAD_BYTES` / `MAX_PIXELS` / `MAX_DIMENSION` | 平台图片限制，默认 20 MB / 2400 万像素 / 单边 8192 |
| `MAX_BATCH` / `MAX_ACTIVE_JOBS` | 默认 100 页 / 每用户 120 活动任务（包含等待、运行和结果不明任务） |
| `USER_QUEUE_CONCURRENCY` / `USER_QUEUE_MAX_CONCURRENCY` | 用户后端默认并发 2 / 可配置上限 10；两项均限定 1–10，默认值受上限约束 |
| `DISPATCH_MAX_JOBS` | 每次 dispatcher 最多新增名额及最多发布消息的数量，默认 100；不是全平台并发上限 |
| `DISPATCH_INTERVAL_SECONDS` / `QUEUE_REPUBLISH_SECONDS` | 轮询间隔默认 2 秒 / 已获名额的丢失消息重投间隔默认 60 秒 |

开发登录只适用于回环地址和隔离测试。公开部署必须关闭 `DEV_AUTH`，配置实际 OIDC、扩展 ID、HTTPS 入口和持久化备份。用户名登录不会用于生产身份校验。

`OPENAI_*` / `PROVIDERS_JSON` 只初始化数据库中尚不存在的供应商，保留运营界面之后修改的配置。已有供应商通过管理员 PUT 更新，配置变更会改变缓存与报价版本。密钥仅通过后端环境变量引用，不进入 API 响应、队列、任务快照或前端。

## API 契约

交互式接口文档：`/docs`，机器契约：`/openapi.json`。公共响应模型位于 `app/schemas.py`；队列请求与响应模型单独位于 `app/queue_api.py`。

供应商、额度调整与结果核实路由位于 `app/admin_api.py`，由 `main.py` 注册；共用身份、额度和幂等实现。JSON 请求的额外字段拒绝规则集中在 `app/request_models.py`。本轮拆分保持全部 38 个 API 路径及 OpenAPI 契约不变，见[代码规范与模块维护](../docs/CODE_QUALITY.md)。

- `GET /v1/auth/config`；开发环境 `POST /v1/auth/dev {username}` 返回 Bearer token 和用户。
- `GET /v1/capabilities` 返回 AI 翻译能力、语言、限制、测试点数及已登录用户额度。
- `POST /v1/images` multipart `image` 上传原图，不会自动翻译。
- `POST /v1/translations/redraw` multipart `asset_id` 或 `image`（二选一）及 `target_language`；必须携带 `Idempotency-Key`；HTTP 202 返回持久化任务。
- `POST /v1/jobs/status {ids}` 最多 100 个任务；`GET /v1/jobs` 为当前用户分页历史。
- `POST /v1/quotes {asset_ids,mode:"redraw",target_language}`；`POST /v1/translation-batches {quote_id,max_credits}` 绑定预算和幂等键。
- 创建单页/批次响应中的 `requested_asset_id` 表示本次提交或报价的图片，`input_asset_id` 始终保留共享任务真实输入；批次响应的 `batch_id` / `ordinal` 属于本次批次。一个任务可能对应多个请求图片或批次页，客户端应按请求关联挂页，不应仅凭任务真实输入或仅凭 job ID 去除批次页。
- `GET /v1/translation-batches/{id}` 按稳定页序分页；对应 `/cancel` 取消未执行页，并要求运行中任务丢弃结果。
- `POST /v1/jobs/{id}/rerun {quote_id,max_credits}` 绑定该页及目标语言的有效报价后强制创建新版本；价格或配置变化时要求重新确认，不能静默加价。结果不明任务还必须显式传 `acknowledge_unknown_cost:true`。
- `GET /v1/images/{id}/access` 返回需要 Bearer 的相对下载路径；前端授权 fetch 后创建本地 Blob URL。地址不携带 token，不公开图片桶。
- `DELETE /v1/images/{id}` 撤销原图及衍生结果访问；`GET /v1/me/usage` 返回可用/预占额度与分页账本。
- `GET /v1/me/queue` 查看用户后端队列；`PUT /v1/me/queue {concurrency:2}` 持久化并发设置，限定 1–10 且不超过服务端上限，`null` 恢复默认。响应包括 `concurrency`（用户覆盖值）、`effective_concurrency`、`default_concurrency`、`max_concurrency`、`queued`、`dispatched`、`running`；`dispatched` 是 `queued` 中已获执行名额的子集，并不保证消息已进入 Redis。
- 管理员可通过 `GET/PUT /v1/admin/users/{user_id}/queue` 读取或修改同一设置；普通用户只能操作自己的设置，未知用户返回 404。
- `/v1/admin/providers`、`/v1/admin/jobs`、`/v1/admin/users` 仅允许运营角色；供应商 PUT/PATCH、明确的收费测试、幂等发放额度与结果核实均有对应端点。

## 执行与结算保证

创建任务、预占额度和 outbox 同一事务提交。Redis 丢失的排队消息可重新投递；worker 原子领取当前 attempt，调用前持久化 intent，并验证执行版本与租约。重复消息、重复创建和重复结算由条件更新与唯一键防重。

### 跨设备确认去重

文件匹配是只读操作，两个设备可能同时匹配不到结果，再分别获取报价并确认。真正的执行去重在 `create_job` 持有用户锁时完成：相同用户、内容 SHA-256、模式、语言和有效配置版本，优先复用仍有效且没有取消/丢弃标记的 `queued`、`running`、`outcome_unknown` 任务。复用不创建 outbox、不增加执行名额、不再次预占，活动数满额或没有剩余额度也允许复用；结果不明任务保持等待核实。显式 `force`/`rerun` 仍创建新版本，并保留结果不明重跑的额外确认。

图片重绘的结果不明保护跨配置生效：只要同用户、内容和语言的旧 `outcome_unknown` 原图仍有效且未取消/丢弃，普通新请求即使改了供应商或价格，也返回该未决任务并记录请求收据，防止配置变化触发重复付费调用。此保护不改变成功结果的配置隔离，也不跨配置阻塞常规模式；明确确认的 `force`/`rerun` 不受普通请求去重限制。

每个操作编号通过 `JobRequest` 保存请求摘要与实际任务引用，包括复用别人的操作所创建的任务。相同编号重发会返回原绑定任务，不受后续成功、失败、配置变化影响；修改请求参数仍返回幂等冲突。每个批次通过独立 `BatchItem` 保存请求图片、页序与任务引用，多个批次或同批次相同内容页可以共享同一执行。取消任一引用该任务的批次，或直接取消该任务，会同时影响本账户其他引用；取消和结算仍只发生一次。

报价与 `max_credits` 继续约束已确认的价格上界。批次 `total_cost` 返回本次真正新增的预占，已有活动任务复用与成功缓存命中为 0；`Job.cost` 表示任务本身的成本，不表示当前批次再次收费。余额仅在真正新建时原子检查，批次任一新页额度不足或输入无效时，整个批次、关联、收据与新增预占一起回滚。成功结果按既有规则生成免费缓存版本；有效原图的 `no_text` 终态同样生成免费 `no_text` 缓存版本，不新增 outbox 或重新执行 OCR。

迁移 `0006` 创建 `batch_items` 和 `job_requests`，不回填旧批次。任务状态与图片墓碑使用 PostgreSQL `FOR NO KEY UPDATE` 行锁：状态写入仍互斥，同时允许创建收据/批次关联的外键 `KEY SHARE` 锁，避免“创建持 User、完成持 Job”构成死锁；任务和图片主键保持不变。

### 用户公平队列

调度单位是用户，单页、多个批次、`classic` 和 `redraw` 共用该用户的后端名额。数据库中的 `scheduler_state` 持久化轮转游标和递增序号：从上次用户之后开始，按稳定用户 ID 顺序寻找有等待任务且有空闲名额的用户，每轮为其分配一页，再轮到下一用户；用户内部按任务创建时间、页序和任务 ID 排序。某用户积压超过 100 页不会挡住其他用户，也不能通过创建新批次或切换模式扩大自己的名额。已完成、取消和等待人工核实的任务不占执行名额。

名额表 `queue_admissions` 在发布 Redis 消息之前提交，统计“已分配但未领取 + 正在运行”的任务总数。多个 dispatcher、worker 领取和设置变更通过数据库调度锁协调，不依赖进程内计数。worker 必须提供匹配当前名额的投递 token，并重新检查用户运行数及图片供应商并发限制；没有 token、旧 token、重复消息和已结束任务均不能执行。发布后数据库提交失败最多产生同 token 的重复消息；丢失消息重投复用同一名额，不推进轮转游标或重复预占额度。

用户降低并发时保留已经运行的任务，并撤销超额的、尚未领取的名额；旧消息立即失效。当前运行数可能暂时高于新值，待其自然完成后才继续领取。取消单页/批次、原图删除、完成或失败会使名额在下次调度时可复用；运行中取消仍占名额直到执行结束或租约恢复。调用前失联和常规翻译本地恢复会撤销旧名额，使用新 token 重新参与用户轮转；已写入图片模型调用意图的任务仍遵守结果不明处理，不自动重发付费调用。

公平性保证的是数据库分配顺序和每用户占用上限。两种模式的 worker 数量、供应商并发及执行耗时不同，实际开始/结束顺序不保证完全交替。供应商暂时满载时，worker 放弃本次领取、任务保留名额并等待 `QUEUE_REPUBLISH_SECONDS` 后重投，默认最多另等约 60 秒加调度间隔；不会在 worker 内持续重试。全平台可同时存在“用户数 × 每用户名额”的已获名额任务，`DISPATCH_MAX_JOBS` 只限制每次调度工作量。前端请求并发与这些服务端限制独立。

队列模型和逻辑位于 `queue_models.py` / `scheduler.py`，迁移 `0005` 创建状态与索引；API 与 dispatcher 启动时自动迁移。新 worker 不接受旧版只含 job ID 的消息，不提供旧队列数据兼容逻辑。

模型请求可能已经被受理的 5xx、连接中断、超时、调用后进程失联进入 `outcome_unknown`；不会自动重复调用或切换供应商。无真实查询协议时由管理员核实，超过期限自动释放用户预占。已释放的任务后来补交付不会再次扣款。供应商 usage 与用户账本分开保存，缺少 usage 表示未知；已收到 usage 的坏图和比例失败仍保存实际报告。

Base64 严格解码，临时图片 URL 按显式域名名单、每次跳转和 IP 范围验证，并将 HTTPS socket 绑定到已检查的公网 IP，保留 TLS 主机名验证。响应字节、图片格式、尺寸、总处理 deadline 和 Celery 最终时限受限。成功结果必须可解码、宽高比合理并已保存；这些校验不等同于翻译质量验收。

图片删除先持久化 tombstone，访问同时检查原图祖先状态。运行中任务丢弃返回结果；dispatcher 分批清理过期、删除与孤立对象，并标记物理清理完成以避免清理饥饿。不存在永久公开链接。

## 验证

```powershell
.venv/Scripts/python.exe -m pytest -q
```

本地 SQLite 测试使用临时目录、临时账号与模拟上游，覆盖任务幂等、重复投递、worker 租约恢复、结果不明处理、取消/删除竞争、预算原子性、额度调整、缓存过期、跨用户隔离、multipart 协议、供应商错误分类、usage 保留、200 个以上对象清理与 chunked 请求限制。模拟上游验证契约与业务行为，不构成真实 AI 翻译效果证据。真实供应商测试与截图对照由仓库验证记录单独报告。

`tests/test_queue.py` 覆盖持久轮转、多批次/单页/跨模式共用名额、超过扫描窗口的积压、发布失败和丢消息重投、取消恢复、token 失效、下调上限、接口权限及多 SQLite 连接竞争。原有 worker 测试通过 `conftest.admit_pending/run_job/claim_job` 使用真实调度入口与投递 token，没有测试专用领取绕过。

`tests/test_shared_jobs.py` 验证多请求幂等收据、活动/未知任务复用、跨图片别名的批次页序、实际成本、共享取消及预算失败原子回滚。`tests/test_shared_jobs_postgres.py` 还验证两设备先同时匹配未命中再分别确认、单页与批次竞争，以及 worker 持任务锁并被用户锁阻塞时插入共享任务外键的受控竞争；这些测试沿用独立 PostgreSQL 测试库，供应商均为模拟。

`tests/test_postgres_concurrency.py` 和 `tests/test_queue_postgres.py` 是显式启用的真实 PostgreSQL 并发验证，使用独立的 `nodecomics_concurrency_test` 数据库及每例随机 schema，禁止使用产品数据库。前者文件头记录 Docker 命令和 `RUN_POSTGRES_CONCURRENCY=1` 环境要求；后者验证多 dispatcher 轮转、跨模式重复 worker、限额下调竞争和多个发布者领取同一名额。运行 Docker 命令时将这两个测试文件传给 pytest 即可。未启用时明确跳过，不能将跳过报告成通过。
