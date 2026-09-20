# Node Comics 后端

2026-09-19 已实现[阅读计划契约](../docs/READING_TRANSLATION_CONTRACT.md)：普通／PLUS 分别最多新增 30／100 张翻译图片每滚动 60 秒，取消账户在途数量限制。统一逐页回执、断线核实、会话优先级与增量通知；后台持久任务、公平调度和私有 R2 保留。

数据库只保留最终初始基线 `results_0001`，必须使用全新空库。旧迁移链、提交清单接口和用户队列接口已删除，无升级或兼容分支。当前代码与本地隔离验收不代表已更新[VPS 部署](../docs/VPS_DEPLOYMENT.md)。

FastAPI／SQLAlchemy／PostgreSQL 控制服务管理任务；独立 [classic-engine](../services/classic-engine/README.md) 通过整页租约执行常规翻译。文本供应商在后台创建和版本化管理，见[供应商设计](../docs/TRANSLATION_PROVIDERS.md)。Paddle 默认关闭，沙盒与生产使用不同数据库，见[支付接入](../docs/PADDLE_BILLING_DESIGN.md)。后台“系统设置”统一维护分钟速率、上传和反馈保护，见[系统设置](../docs/SYSTEM_SETTINGS.md)。

## 运行

需要 Python 3.11、PostgreSQL（隔离验证使用 17.6）、私有 R2。后端默认生产模式并校验完整身份配置；以下为显式开发环境入口。在根目录填写 `.env` 后：

```powershell
./scripts/bootstrap.ps1
# 填写 R2、图片供应商后启动本地开发集群：
./scripts/bootstrap.ps1 -Start
# 配置 ADMIN_WEB_PATH 后，在该后台入口的 #translation-providers 创建文本供应商。
```

本地 Compose 项目 `node-comics-nodes` 使用 `nodes_postgres` 卷，默认库 `nodecomics_cluster`。新基线 `results_0001` 不升级旧表；已有旧版本卷需另选全新 Compose 项目 / 数据库，不会自动清空。本次不自动切换已有实例。若旧 API 占用 18088，在 `deploy/.env.local` 设置新的 `API_PORT`。生产使用 `deploy/.env.production` 与 `scripts/bootstrap.ps1 -Production -Start`，固定独立项目 `node-comics-production`。不同环境使用独立 R2 前缀。生产启动和身份校验见[生产身份配置](../docs/PRODUCTION_IDENTITY.md)。

三个控制进程可独立运行。以下仅列进程入口；本机运行需先安装 `backend/requirements.txt`，启动器或秘密管理需预先向各进程注入完整 `DATABASE_URL`、身份和存储配置，程序不会自动读取 `deploy/.env.local` / `deploy/.env.production`。本地调试必须显式设置 `APP_ENV=development`，不能依赖默认配置绕过生产校验：

```powershell
cd backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 18088 --no-access-log
# 另两个终端：
python -m app.workers
python -m app.dispatcher
```

API、control-worker、maintenance 使用相同数据库与私有 R2 配置；不挂载共享图片卷。独立计算节点只需要内部 API 令牌和本机引擎令牌，部署方式见[节点说明](../docs/NODE_CONFIGURATION.md)。`local` 存储仅供显式开发 / 测试环境、`DEV_AUTH=true` 且配置足够长度签名密钥的隔离验证，不能作为公开部署。

## 配置

| 配置 | 默认／用途 |
| --- | --- |
| `FREE_IMAGES_PER_MINUTE` / `PLUS_IMAGES_PER_MINUTE` | 30 / 100，首次初始化种子；后续在后台配置，跨模式、语言和设备共用滚动 60 秒预算 |
| `PLAN_REQUESTS_PER_MINUTE` / `PLAN_REQUEST_BURST` / `PLAN_REQUEST_CONCURRENCY` | 300 / 30 / 4，独立 HTTP 请求保护，与新增翻译图片数分开 |
| `FREE_SCHEDULER_WEIGHT` / `PLUS_SCHEDULER_WEIGHT` | 1 / 2，同级用户资源份额 |
| `REALTIME_SHARE` | 0.9，预存保底 0.1，空闲互借 |
| `PRIORITY_TTL_SECONDS` | 90，离线自动降为预存 |
| 节点身份 | 后台添加后一次性返回 NODE_ID / NODE_TOKEN；每节点独立凭据，数据库仅保存摘要 |
| `CLUSTER_LEASE_SECONDS` | 90，心跳续期与代次隔离 |
| `CLUSTER_TEXT_SLOTS` / `CLUSTER_REDRAW_SLOTS` | 各 4，仅首次创建资源池时使用，后续在后台配置，所有控制副本共享限额 |
| `CLUSTER_UPLOAD_SLOTS` | 2，仅首次创建时使用，后续在后台配置 |
| 后台文本供应商 `config.requests_per_minute` | 默认60，每供应商独立 RPM，跨副本与该供应商历史版本共享；与文本执行位分开 |
| `CLUSTER_STAGE_ATTEMPTS` | 3，安全阶段恢复上限 |
| `UPLOAD_SESSION_TTL_SECONDS` / `UPLOAD_SESSION_MAX_LIFETIME_SECONDS` | 900 / 3600 |
| 上传并发、收流超时、反馈预算 | 后台“系统设置”统一维护；对应环境变量只作为首次初始化种子，见[参数表](../docs/SYSTEM_SETTINGS.md) |
| `FREE_DAILY_PAGES` / `PLUS_MONTHLY_REDRAW_PAGES` | 100 / 300，独立于分钟速率 |
| `RETENTION_DAYS` | 默认0表示无限期保留；当前部署为0 |
| `RESULT_STORAGE_BACKEND` | 部署固定 `r2`，含原图与译图 |
| `R2_ENDPOINT_URL` / `R2_BUCKET` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | 私有桶 S3 配置 |
| `R2_KEY_PREFIX` | 独立部署专用前缀 |
| `CLASSIC_ENABLED` | 常规引擎总开关；文本模型、协议、密钥、计量和重试在后台供应商中配置，默认关闭；接入要求见[计算协议](../docs/COMPUTE_PROTOCOL.md) |
| `OPENAI_*` / `PROVIDERS_JSON` | 初始化图片供应商，后续管理员维护 |

文本供应商密钥保存在后端 DB revision 中，调用前严格校验完整配置快照并加载对应版本密钥，不读取环境变量或借用图片供应商配置。密钥不进入 API 响应、任务快照或计算节点；数据库及备份包含敏感密钥，必须限制访问权限。有效供应商及版本进入内容缓存身份；会员页数和权重不改变图片缓存身份。

## 管理后台

公开官网位于 [website](website/README.md)，与 API 共用 `https://comics.nodelane.net`；Astro 静态输出、React 账户岛、五语独立字典，并复用相同 OIDC。Docker 构建自动打包，商店 URL 配置及身份回调要求见官网说明。

服务端由 `ADMIN_WEB_PATH` 配置私有入口，提供独立 **React + TypeScript + Vite** 后台，可查看用户与权益、节点心跳与容量、双模式积压，以及逐页翻译的等待／执行耗时、交付节点和执行机。构建、登录、统计口径和验收见[后台说明](../docs/ADMIN_CONSOLE.md)。Docker 构建自动打包页面；本机启动 API 前先在 `backend/admin-ui` 执行 `npm ci` 和 `npm run build`。

## API

交互文档 `/docs`，机器契约 `/openapi.json`。

- `POST /v1/translation-plans`：自动阅读至多当前页及后两页；手动重试一页。每项稳定 `operation_key`，逐页受理、拒绝或延后；新任务与分钟计数、额度预占同事务提交。
- `POST /v1/translation-operations/resolve`：至多十个操作编号核实；`GET /v1/translation-operations` 分页历史。
- `PUT /v1/reading-sessions/{id}/lease`：阅读优先级续租与条件接管，不重提生成请求。
- `PUT /v1/uploads/{id}/content`、`POST /v1/uploads/{id}/complete`：有限字节上传与校验；已有原图无需重传。
- `GET /v1/me/translation-changes`：最多 20 秒长轮询，直接返回任务增量及权益策略；不重复逐页查询。
- `GET /v1/images/{id}/access`：所有权、元数据寿命核验后签名直链；状态查询不探测 R2。
- `/internal/compute/v2/nodes/register`、`/internal/compute/v2/nodes/{id}/claim` 等：受认证整页计算协议；分析、授权上传、交付与恢复见[计算协议](../docs/COMPUTE_PROTOCOL.md)。
- `GET/POST /v1/admin/compute-nodes`：查询／添加节点，`/{id}/config` 编辑配置、`/{id}/rotate-credential` 轮换凭据。管理员 `reconcile`／`reconcile-image` 核实未知结果或补交译图，不重新调用模型。
- 权益、限时赠送、用量账本、作品文件页匹配和私有反馈接口继续适用。

## 故障与安全

调度、受理、排序、租约和结算按 scheduler → user/job 锁顺序短事务完成。网络和模型 I/O 不持调度锁。固定结果摘要与租约记录的不可变内容对象键防止迟到结果覆盖，恢复重新核验租约。重绘已持久化调用意图后不自动重发；未知期限释放后补交付不补扣。

输入图按实际接收字节、摘要、可解码尺寸验证。图片供应商 URL 通过白名单、DNS/IP 和每次跳转校验；输出需解码和持久化成功才结算。原图和译图默认无限期保留，最近授权访问时间供未来清理策略使用；活跃引用保护原图。删除先提交墓碑；签名已经发出时可能在其短暂有效期内继续读取。

## 验证

2026-09-20 已移除项目的非 Docker 虚拟环境、依赖目录与运行缓存；使用隔离测试容器，不需要宿主机 Python/npm 环境。以下命令从仓库根目录执行：

```powershell
docker compose -p node-comics-tests -f deploy/compose.tests.yaml up --build --abort-on-container-exit --exit-code-from tests
docker compose -p node-comics-tests -f deploy/compose.tests.yaml down
```

PostgreSQL 并发套件必须显式设置 `RUN_POSTGRES_CONCURRENCY=1`、`TEST_PG_HOST`、`TEST_PG_PORT`、`TEST_PG_USER`、`TEST_PG_PASSWORD`；只接受 `nodecomics_concurrency_test`，每例随机 schema。未启用的用例显示 skipped。节点与引擎单元检查见节点说明。

运行前设置 `$env:RUN_POSTGRES_CONCURRENCY='1'` 可启用真实 PostgreSQL 套件。上述 Compose 自带只在容器网络访问、使用 tmpfs 的专用测试库，不读产品数据库或环境文件；每个测试仍使用随机 schema。调度负载基准另需 `RUN_SCHEDULER_SCALE=1`，常规回归无需启用。DB 供应商 fixture 的真实接入边界见[常规翻译验证](../services/classic-engine/README.md)。

`tests/translation_fixtures.py` 为 SQLite、PostgreSQL、HTTP 子进程及手工 UI 显式创建隔离 DB 文本供应商，使用假密钥；修改协议或模型先写新 revision 再获取快照。测试 fixture 的创建不属于应用启动 seed。

`tests/manual_ui_server.py` 使用临时 SQLite、合成图片与模拟重绘供应商启动真实 API/control-worker，监听 18089；`tests/manual_admin_server.py` 提供 18090 管理后台隔离数据。两者均显式创建 DB 文本供应商，不读取生产环境文件、不调用付费模型。浏览器及完整证据见[验收说明](../docs/READING_TRANSLATION_CONTRACT.md)。
