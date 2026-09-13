# Node Comics 后端

当前实现只包含图片模型 AI 翻译。`redraw` 是 API 中保留的模式标识；图片与目标语言直接送入服务端的 `images/edits` 适配器，没有 OCR 或普通机翻前置步骤。

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
| `MAX_BATCH` / `MAX_ACTIVE_JOBS` / `BATCH_WINDOW` | 默认 100 页 / 每用户 120 活动任务 / 每批次同时投递 3 页 |

开发登录只适用于回环地址和隔离测试。公开部署必须关闭 `DEV_AUTH`，配置实际 OIDC、扩展 ID、HTTPS 入口和持久化备份。用户名登录不会用于生产身份校验。

`OPENAI_*` / `PROVIDERS_JSON` 只初始化数据库中尚不存在的供应商，保留运营界面之后修改的配置。已有供应商通过管理员 PUT 更新，配置变更会改变缓存与报价版本。密钥仅通过后端环境变量引用，不进入 API 响应、队列、任务快照或前端。

## API 契约

交互式接口文档：`/docs`，机器契约：`/openapi.json`。公开响应模型位于 `app/schemas.py`。

- `GET /v1/auth/config`；开发环境 `POST /v1/auth/dev {username}` 返回 Bearer token 和用户。
- `GET /v1/capabilities` 返回 AI 翻译能力、语言、限制、测试点数及已登录用户额度。
- `POST /v1/images` multipart `image` 上传原图，不会自动翻译。
- `POST /v1/translations/redraw` multipart `asset_id` 或 `image`（二选一）及 `target_language`；必须携带 `Idempotency-Key`；HTTP 202 返回持久化任务。
- `POST /v1/jobs/status {ids}` 最多 100 个任务；`GET /v1/jobs` 为当前用户分页历史。
- `POST /v1/quotes {asset_ids,mode:"redraw",target_language}`；`POST /v1/translation-batches {quote_id,max_credits}` 绑定预算和幂等键。
- `GET /v1/translation-batches/{id}` 按稳定页序分页；对应 `/cancel` 取消未执行页，并要求运行中任务丢弃结果。
- `POST /v1/jobs/{id}/rerun {quote_id,max_credits}` 绑定该页及目标语言的有效报价后强制创建新版本；价格或配置变化时要求重新确认，不能静默加价。结果不明任务还必须显式传 `acknowledge_unknown_cost:true`。
- `GET /v1/images/{id}/access` 返回需要 Bearer 的相对下载路径；前端授权 fetch 后创建本地 Blob URL。地址不携带 token，不公开图片桶。
- `DELETE /v1/images/{id}` 撤销原图及衍生结果访问；`GET /v1/me/usage` 返回可用/预占额度与分页账本。
- `/v1/admin/providers`、`/v1/admin/jobs`、`/v1/admin/users` 仅允许运营角色；供应商 PUT/PATCH、明确的收费测试、幂等发放额度与结果核实均有对应端点。

## 执行与结算保证

创建任务、预占额度和 outbox 同一事务提交。Redis 丢失的排队消息可重新投递；worker 原子领取当前 attempt，调用前持久化 intent，并验证执行版本与租约。重复消息、重复创建和重复结算由条件更新与唯一键防重。

模型请求可能已经被受理的 5xx、连接中断、超时、调用后进程失联进入 `outcome_unknown`；不会自动重复调用或切换供应商。无真实查询协议时由管理员核实，超过期限自动释放用户预占。已释放的任务后来补交付不会再次扣款。供应商 usage 与用户账本分开保存，缺少 usage 表示未知；已收到 usage 的坏图和比例失败仍保存实际报告。

Base64 严格解码，临时图片 URL 按显式域名名单、每次跳转和 IP 范围验证，并将 HTTPS socket 绑定到已检查的公网 IP，保留 TLS 主机名验证。响应字节、图片格式、尺寸、总处理 deadline 和 Celery 最终时限受限。成功结果必须可解码、宽高比合理并已保存；这些校验不等同于翻译质量验收。

图片删除先持久化 tombstone，访问同时检查原图祖先状态。运行中任务丢弃返回结果；dispatcher 分批清理过期、删除与孤立对象，并标记物理清理完成以避免清理饥饿。不存在永久公开链接。

## 验证

```powershell
.venv/Scripts/python.exe -m pytest -q
```

本地 SQLite 测试使用临时目录、临时账号与模拟上游，覆盖任务幂等、重复投递、worker 租约恢复、结果不明处理、取消/删除竞争、预算原子性、额度调整、缓存过期、跨用户隔离、multipart 协议、供应商错误分类、usage 保留、200 个以上对象清理与 chunked 请求限制。模拟上游验证契约与业务行为，不构成真实 AI 翻译效果证据。真实供应商测试与截图对照由仓库验证记录单独报告。

`tests/test_postgres_concurrency.py` 是显式启用的真实 PostgreSQL 并发验证，使用独立的 `nodecomics_concurrency_test` 数据库及每例随机 schema，禁止使用产品数据库。文件头记录 Docker 命令和 `RUN_POSTGRES_CONCURRENCY=1` 环境要求，涵盖 8 路幂等创建、双 worker、过期旧 attempt、删除与结果落库交错及双进程迁移；未启用时会明确跳过这 5 项，不能将跳过报告成通过。
