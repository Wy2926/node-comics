# Node Comics 后端

2026-09-16 部署更新：当前服务端已在美国 VPS 的三个容器中运行，复用既有 PostgreSQL，本机承担图像计算。线上入口与独立生产 Compose 见[部署说明](../docs/VPS_DEPLOYMENT.md)；下文“未公开部署”为此前实现阶段记录。

2026-09-16：已加入生产身份校验、公钥撤销、提交反滥用、共享原图/已完成译图复用、监控与隔离恢复；移除一天后无引用对象删除。新空库基线 `shared_0001`，不兼容旧数据。状态和验证见[本轮修复](../docs/PRODUCTION_FIXES.md)，未公开部署。

当前代码迁移头为 `shared_0005_billing`，直接创建含交易处理回执与订阅对账进度的 Paddle 表结构，不支持此前支付库或旧字段格式。已使用旧 Paddle 结构的沙盒需新建隔离数据库；未运行过支付迁移的 `shared_0004_text_providers` 可直接创建当前支付表。首次完整分页核对交易，后续按更新时间增量拉取；按页原子结算、跳过已处理交易版本，全部分页成功后推进进度。支付默认关闭；沙盒与生产使用不同数据库，启动时拒绝混用已有支付账户环境。API 与维护服务读取相同 `PADDLE_*` 配置，维护服务独立线程处理回调重试和漏通知补查。隔离沙盒启动及验收见 [Paddle 接入](../docs/PADDLE_BILLING_DESIGN.md#11-业务权益接入与当前验收)，增量规则见[对账优化](../docs/PADDLE_BILLING_DESIGN.md#12-增量对账与公共实现)。本轮未部署生产支付功能。

此前 `shared_0004_text_providers` 新增 DB 文本供应商及版本表和请求计量索引，无自动配置 seed，不导入旧配置，不兼容旧任务快照和旧文本供应商数据。后台 `/admin/#translation-providers` 创建供应商，首次创建自动设为默认，支持 OpenAI Chat Completions（默认）和 Responses。默认选择与版本配置仅影响新任务；独立 RPM、停用暂停及迁移边界见 [LLM 翻译供应商](../docs/TRANSLATION_PROVIDERS.md)。

此前 `shared_0003_system_settings` 增加上传门禁、反馈预算和统一系统设置。后台 `/admin/#settings` 管理 8 项保护参数，保存后供所有 API 副本的新请求使用，见[系统设置与验证](../docs/SYSTEM_SETTINGS.md)。

FastAPI／SQLAlchemy／PostgreSQL 控制服务，私有 R2 保存原图与最终译图，独立计算代理按阶段拉取常规翻译。前后端使用持久提交清单和双模式队列，已删除旧 preview/batch、Celery/Redis 与固定用户执行上限。产品规则见[集群说明](../docs/TRANSLATION_CLUSTER_DESIGN.md)。

## 运行

需要 Python 3.11、PostgreSQL（隔离验证使用 17.6）、私有 R2。后端默认生产模式并校验完整身份配置；以下为显式开发环境入口。在根目录填写 `.env` 后：

```powershell
./scripts/bootstrap.ps1
# 填写 R2、图片供应商后启动本地开发集群：
./scripts/bootstrap.ps1 -Start -Classic
# 启动后在 /admin/#translation-providers 创建文本供应商。
```

本地 Compose 项目 `node-comics-nodes` 使用 `nodes_postgres` 卷，默认库 `nodecomics_cluster`。新基线 `shared_0001` 不升级旧表；已有旧版本卷需另选全新 Compose 项目 / 数据库，不会自动清空。本次不自动切换已有实例。若旧 API 占用 18088，在 `deploy/.env.local` 设置新的 `API_PORT`。生产使用 `deploy/.env.production` 与 `scripts/bootstrap.ps1 -Production -Start`，固定独立项目 `node-comics-production`。不同环境使用独立 R2 前缀。生产启动和身份校验见[生产身份配置](../docs/PRODUCTION_IDENTITY.md)。

三个控制进程可独立运行。以下仅列进程入口；启动器或秘密管理需预先向各进程注入完整 `DATABASE_URL`、身份和存储配置，程序不会自动读取 `deploy/.env.local` / `deploy/.env.production`。本地调试必须显式设置 `APP_ENV=development`，不能依赖默认配置绕过生产校验：

```powershell
cd backend
.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 18088 --no-access-log
# 另两个终端：
.venv/Scripts/python.exe -m app.workers
.venv/Scripts/python.exe -m app.dispatcher
```

API、control-worker、maintenance 使用相同数据库与私有 R2 配置；不挂载共享图片卷。独立计算节点只需要内部 API 令牌和本机引擎令牌，部署方式见[节点说明](../services/compute-agent/README.md)。`local` 存储仅供显式开发 / 测试环境、`DEV_AUTH=true` 且配置足够长度签名密钥的隔离验证，不能作为公开部署。

## 配置

| 配置 | 默认／用途 |
| --- | --- |
| `FREE_QUEUE_CAPACITY` / `PLUS_QUEUE_CAPACITY` | 每模式 10 / 500 页 |
| `FREE_REALTIME_SLOTS` / `PLUS_REALTIME_SLOTS` | 每模式 2 / 10 页 |
| `FREE_SCHEDULER_WEIGHT` / `PLUS_SCHEDULER_WEIGHT` | 1 / 2，同级用户资源份额 |
| `REALTIME_SHARE` | 0.9，预存保底 0.1，空闲互借 |
| `PRIORITY_TTL_SECONDS` | 90，离线自动降为预存 |
| 节点身份 | 后台添加后一次性返回 NODE_ID / NODE_TOKEN；每节点独立凭据，数据库仅保存摘要 |
| `CLUSTER_LEASE_SECONDS` | 90，心跳续期与代次隔离 |
| `CLUSTER_TEXT_SLOTS` / `CLUSTER_REDRAW_SLOTS` | 各 4，仅首次创建资源池时使用，后续在后台配置，所有控制副本共享限额 |
| `CLUSTER_UPLOAD_SLOTS` | 2，仅首次创建时使用，后续在后台配置 |
| 后台文本供应商 `config.requests_per_minute` | 默认60，每供应商独立 RPM，跨副本与该供应商历史版本共享；与文本执行位分开 |
| `CLUSTER_MAX_IMAGE_STAGES` | 64，预存已 OCR 待渲染水位 |
| `CLUSTER_STAGE_ATTEMPTS` | 3，安全阶段恢复上限 |
| `UPLOAD_SESSION_TTL_SECONDS` / `UPLOAD_SESSION_MAX_LIFETIME_SECONDS` | 900 / 3600 |
| 上传并发、收流超时、反馈预算 | 后台“系统设置”统一维护；对应环境变量只作为首次初始化种子，见[参数表](../docs/SYSTEM_SETTINGS.md) |
| `FREE_DAILY_PAGES` / `PLUS_MONTHLY_REDRAW_PAGES` | 100 / 300，独立于队列容量 |
| `RETENTION_DAYS` | 默认0表示无限期保留；当前部署为0 |
| `RESULT_STORAGE_BACKEND` | 部署固定 `r2`，含原图与译图 |
| `R2_ENDPOINT_URL` / `R2_BUCKET` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | 私有桶 S3 配置 |
| `R2_KEY_PREFIX` | 独立部署专用前缀 |
| `CLASSIC_ENABLED` | 常规引擎总开关；文本模型、协议、密钥、计量和重试在后台供应商中配置，见[常规说明](../docs/CLASSIC_IMPLEMENTATION.md) |
| `OPENAI_*` / `PROVIDERS_JSON` | 初始化图片供应商，后续管理员维护 |

文本供应商密钥保存在后端 DB revision 中，调用前严格校验完整配置快照并加载对应版本密钥，不读取环境变量或借用图片供应商配置。密钥不进入 API 响应、任务快照或计算节点；数据库及备份包含敏感密钥，必须限制访问权限。有效供应商及版本进入内容缓存身份；会员页数和权重不改变图片缓存身份。

## 管理后台

服务端 `/admin/` 提供独立 **React + TypeScript + Vite** 后台，可查看用户与权益、节点心跳与容量、双模式积压，以及逐页翻译的等待／执行耗时、交付节点和执行机。构建、登录、统计口径和验收见[后台说明](../docs/ADMIN_CONSOLE.md)。Docker 构建自动打包页面；本机启动 API 前先在 `backend/admin-ui` 执行 `npm ci` 和 `npm run build`。

## API

交互文档 `/docs`，机器契约 `/openapi.json`。

- `POST /v1/translation-submissions`：稳定 `Idempotency-Key`、模式、语言、`max_quota_pages`、有序图片摘要/大小/文件页身份；受理与预占原子提交。
- `PUT /v1/uploads/{id}/content`、`POST /v1/uploads/{id}/complete`：上传原图后排入异步校验，复用图不重复上传。
- `GET /v1/translation-submissions` 与 `GET .../{id}`：分页摘要／原回执；`POST .../{id}/cancel` 停止所属任务。
- `GET /v1/me/queues`、`GET .../{mode}/items`、`POST .../{mode}/priority`、`POST .../{mode}/pause`：独立模式状态与实时意图。
- `GET /v1/me/translation-changes`：游标增量同步；`GET /v1/jobs/{id}`、`POST /v1/jobs/status`：有界查询。
- `GET /v1/images/{id}/access`：所有权、元数据寿命核验后签名直链；状态查询不探测 R2。
- `/internal/nodes/register`、`/internal/nodes/{id}/claim`、`/internal/leases/{id}/{input,heartbeat,complete}`：受认证阶段协议。
- `GET/POST /v1/admin/compute-nodes`：查询／添加节点，`/{id}/config` 编辑配置、`/{id}/rotate-credential` 轮换凭据。管理员 `reconcile`／`reconcile-image` 核实未知结果或补交译图，不重新调用模型。
- 权益、限时赠送、用量账本、作品文件页匹配和私有反馈接口继续适用。

## 故障与安全

调度、受理、排序、租约和结算按 scheduler → user/job 锁顺序短事务完成。网络和模型 I/O 不持调度锁。固定结果摘要与租约记录的不可变内容对象键防止迟到结果覆盖，恢复重新核验租约。重绘已持久化调用意图后不自动重发；未知期限释放后补交付不补扣。

输入图按实际接收字节、摘要、可解码尺寸验证。图片供应商 URL 通过白名单、DNS/IP 和每次跳转校验；输出需解码和持久化成功才结算。原图和译图默认无限期保留，最近授权访问时间供未来清理策略使用；活跃引用保护原图。删除先提交墓碑；签名已经发出时可能在其短暂有效期内继续读取。

## 验证

```powershell
cd backend
.venv/Scripts/python.exe -m pytest tests -q
```

PostgreSQL 并发套件必须显式设置 `RUN_POSTGRES_CONCURRENCY=1`、`TEST_PG_HOST`、`TEST_PG_PORT`、`TEST_PG_USER`、`TEST_PG_PASSWORD`；只接受 `nodecomics_concurrency_test`，每例随机 schema。未启用的用例显示 skipped。节点与引擎单元检查见节点说明。

在独立测试库配置完成后，从 `backend` 执行 `.venv/Scripts/python.exe -m pytest tests -k postgres -q`。调度负载基准另需 `RUN_SCHEDULER_SCALE=1`，常规回归无需启用。DB 供应商 fixture 的本轮结果与真实接入边界见[常规翻译验证](../docs/CLASSIC_IMPLEMENTATION.md#验证与交付边界)。

`tests/translation_fixtures.py` 为 SQLite、PostgreSQL、HTTP 子进程及手工 UI 显式创建隔离 DB 文本供应商，使用假密钥；修改协议或模型先写新 revision 再获取快照。测试 fixture 的创建不属于应用启动 seed。

`tests/manual_ui_server.py` 使用临时 SQLite、合成图片与模拟重绘供应商启动真实 API/control-worker，监听 18089；`tests/manual_admin_server.py` 提供 18090 管理后台隔离数据。两者均显式创建 DB 文本供应商，不读取生产环境文件、不调用付费模型。浏览器及完整证据见[验收说明](../docs/CLUSTER_VALIDATION.md)。
