# Node Comics 后端

FastAPI／SQLAlchemy／PostgreSQL 控制服务，私有 R2 保存原图与最终译图，独立计算代理按阶段拉取常规翻译。前后端使用持久提交清单和双模式队列，已删除旧 preview/batch、Celery/Redis 与固定用户执行上限。产品规则见[集群说明](../docs/TRANSLATION_CLUSTER_DESIGN.md)。

## 运行

需要 Python 3.11、PostgreSQL（隔离验证使用 17.6）、私有 R2。生产关闭 `DEV_AUTH` 并配置 OIDC。在根目录填写 `.env` 后：

```powershell
./scripts/bootstrap.ps1
# 填写 R2、文本/图片供应商与身份配置后启动新集群：
./scripts/bootstrap.ps1 -Start -Classic
```

Compose 项目 `node-comics-cluster` 使用独立 `cluster_postgres` 卷，默认库 `nodecomics_cluster`。新基线 `cluster_0001` 不升级旧表；本次不自动切换已有实例。若旧 API 占用 18088，在 `deploy/.env.local` 设置新的 `API_PORT`。不能把多个环境指向相同 R2 清理前缀。

三个控制进程可独立运行：

```powershell
cd backend
.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 18088 --no-access-log
# 另两个终端：
.venv/Scripts/python.exe -m app.workers
.venv/Scripts/python.exe -m app.dispatcher
```

API、control-worker、maintenance 使用相同数据库与私有 R2 配置；不挂载共享图片卷。独立计算节点只需要内部 API 令牌和本机引擎令牌，部署方式见[节点说明](../services/compute-agent/README.md)。`local` 存储仅供 `DEV_AUTH=true` 的隔离测试，不能作为公开部署。

## 配置

| 配置 | 默认／用途 |
| --- | --- |
| `FREE_QUEUE_CAPACITY` / `PLUS_QUEUE_CAPACITY` | 每模式 10 / 500 页 |
| `FREE_REALTIME_SLOTS` / `PLUS_REALTIME_SLOTS` | 每模式 2 / 10 页 |
| `FREE_SCHEDULER_WEIGHT` / `PLUS_SCHEDULER_WEIGHT` | 1 / 2，同级用户资源份额 |
| `REALTIME_SHARE` | 0.9，预存保底 0.1，空闲互借 |
| `PRIORITY_TTL_SECONDS` | 90，离线自动降为预存 |
| `CLUSTER_NODE_TOKEN` | 至少 32 字符，仅内部节点认证 |
| `CLUSTER_LEASE_SECONDS` | 90，心跳续期与代次隔离 |
| `CLUSTER_TEXT_SLOTS` / `CLUSTER_REDRAW_SLOTS` | 各 4，所有控制副本共享限额 |
| `CLUSTER_UPLOAD_SLOTS` | 2，后台校验原图 |
| `CLUSTER_TEXT_REQUESTS_PER_MINUTE` | 60，实际文本请求计量 |
| `CLUSTER_MAX_IMAGE_STAGES` | 64，预存已 OCR 待渲染水位 |
| `CLUSTER_STAGE_ATTEMPTS` | 3，安全阶段恢复上限 |
| `UPLOAD_SESSION_TTL_SECONDS` / `UPLOAD_SESSION_MAX_LIFETIME_SECONDS` | 900 / 3600 |
| `FREE_DAILY_PAGES` / `PLUS_MONTHLY_REDRAW_PAGES` | 100 / 300，独立于队列容量 |
| `RETENTION_DAYS` | 默认0表示无限期保留；当前部署为0 |
| `RESULT_STORAGE_BACKEND` | 部署固定 `r2`，含原图与译图 |
| `R2_ENDPOINT_URL` / `R2_BUCKET` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | 私有桶 S3 配置 |
| `R2_KEY_PREFIX` | 独立部署专用前缀 |
| `CLASSIC_ENABLED` / `TEXT_*` | 常规及预算配置，见[常规说明](../docs/CLASSIC_IMPLEMENTATION.md) |
| `OPENAI_*` / `PROVIDERS_JSON` | 初始化图片供应商，后续管理员维护 |

供应商密钥只通过后端环境引用，不进入任务快照和前端。配置影响生成结果时进入内容缓存版本；会员页数和权重不改变图片缓存身份。

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
- `GET /v1/admin/compute-nodes`：设备在线和忙碌状态。管理员 `reconcile`／`reconcile-image` 核实未知结果或补交译图，不重新调用模型。
- 权益、限时赠送、用量账本、作品文件页匹配和私有反馈接口继续适用。

## 故障与安全

调度、受理、排序、租约和结算按 scheduler → user/job 锁顺序短事务完成。网络和模型 I/O 不持调度锁。固定结果摘要与每租约对象键防止迟到结果覆盖，恢复重新核验租约。重绘已持久化调用意图后不自动重发；未知期限释放后补交付不补扣。

输入图按实际接收字节、摘要、可解码尺寸验证。图片供应商 URL 通过白名单、DNS/IP 和每次跳转校验；输出需解码和持久化成功才结算。原图和译图默认无限期保留，最近授权访问时间供未来清理策略使用；活跃引用保护原图。删除先提交墓碑；签名已经发出时可能在其短暂有效期内继续读取。

## 验证

```powershell
cd backend
.venv/Scripts/python.exe -m pytest tests -q
```

PostgreSQL 并发套件必须显式设置 `RUN_POSTGRES_CONCURRENCY=1`、`TEST_PG_HOST`、`TEST_PG_PORT`、`TEST_PG_USER`、`TEST_PG_PASSWORD`；只接受 `nodecomics_concurrency_test`，每例随机 schema。未启用的用例显示 skipped。节点与引擎单元检查见节点说明。

`tests/manual_ui_server.py` 使用临时 SQLite、合成图片与模拟重绘供应商启动真实 API/control-worker，监听 18089；不读取生产环境文件，不调用付费模型。浏览器及完整证据见[验收说明](../docs/CLUSTER_VALIDATION.md)。
