# Node Comics 后端

FastAPI + SQLAlchemy + PostgreSQL 控制服务。API、control-worker、maintenance 分别负责请求、任务执行与维护；图像计算由独立节点完成，原图与译图存入私有 R2。

## 运行

推荐 Docker Compose。从仓库根目录执行：

```powershell
./scripts/bootstrap.ps1
# 填写根 .env 中的 R2 与供应商配置
./scripts/bootstrap.ps1 -Start
```

本地 API 默认 `http://127.0.0.1:18088`；环境配置位于 `deploy/.env.local`，后台路径取其中的 `ADMIN_WEB_PATH`。数据库使用 `translations_0001` 空库基线；首次安装准备新库。

直接运行需要 Python 3.11+ 和 [requirements.txt](requirements.txt)，并向各进程注入数据库、身份和存储配置；本地调试显式设置 `APP_ENV=development`。在本目录的三个终端分别执行：

```powershell
python -m uvicorn app.main:app --host 127.0.0.1 --port 18088 --no-access-log
python -m app.workers
python -m app.dispatcher
```

Docker 自动构建官网与管理后台；本机运行页面前，分别在 `website`、`admin-ui` 执行 `npm ci` 和 `npm run build`。正式环境配置与发布见[部署规范](../docs/DEPLOYMENT.md)。

## 开发入口

| 范围 | 规范 |
| --- | --- |
| 公开 API | [翻译契约](../docs/READING_TRANSLATION_CONTRACT.md)、[OpenAPI](../contracts/README.md)；运行时 `/docs` 与 `/openapi.json` |
| 任务执行 | [调度](../docs/TRANSLATION_CLUSTER_DESIGN.md)、[计算协议](../docs/COMPUTE_PROTOCOL.md)、[节点配置](../docs/NODE_CONFIGURATION.md) |
| 账户与支付 | [身份](../docs/PRODUCTION_IDENTITY.md)、[会员](../docs/MEMBERSHIP_AND_QUOTAS.md)、[支付](../docs/STRIPE_BILLING.md) |
| 管理与配置 | [后台](../docs/ADMIN_CONSOLE.md)、[系统设置](../docs/SYSTEM_SETTINGS.md)、[文本供应商](../docs/TRANSLATION_PROVIDERS.md)、[配置模板](../.env.example) |
| 存储与运维 | [R2](../docs/OBJECT_STORAGE.md)、[备份与恢复](../docs/OPERATIONS.md) |

## 验证

在仓库根目录运行隔离测试：

```powershell
docker compose -p node-comics-tests -f deploy/compose.tests.yaml up --build --abort-on-container-exit --exit-code-from tests
docker compose -p node-comics-tests -f deploy/compose.tests.yaml down
```

也可安装依赖后，在本目录执行 `python -m pytest -q tests`。PostgreSQL 并发套件需显式设置 `RUN_POSTGRES_CONCURRENCY=1` 和 `TEST_PG_HOST / PORT / USER / PASSWORD`，仅使用 `nodecomics_concurrency_test`；测试 Compose 提供独立临时库。未启用的用例记为 skipped。

浏览器测试使用 `tests/manual_*_server.py` 的临时库和合成供应商，启动顺序见[脚本入口](../scripts/README.md)。真实 OIDC、R2、支付和模型效果分别验收。
