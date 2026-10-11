# Node Comics 后端

FastAPI + SQLAlchemy + PostgreSQL + Redis 8 控制服务。API、control-worker、maintenance 分别负责请求、任务执行与维护；图像计算由独立节点完成，原图临时保存于中心共享磁盘，常规译文以稀疏覆盖层交付；任务终态立即清理原图。

[集群架构](../docs/TRANSLATION_CLUSTER_DESIGN.md)使用服务器文件保存结果，PostgreSQL 保存任务、译文与权限；所有图片传输直连中心 HTTPS。

## 运行

推荐 Docker Compose。从仓库根目录执行：

```powershell
./scripts/bootstrap.ps1
# 填写根 .env 中的身份与存储配置，供应商在后台配置
./scripts/bootstrap.ps1 -Start
```

本地 API 默认 `http://127.0.0.1:18088`；后台路径取 `deploy/.env.local` 中的 `ADMIN_WEB_PATH`。首次安装准备专用空库；数据库版本、升级及共享 Redis 配置统一见[部署规范](../docs/DEPLOYMENT.md)。

直接运行需要 Python 3.11+、Redis 8 和 [requirements.txt](requirements.txt)，并向各进程注入数据库、Redis、身份和存储配置；`REDIS_URL` 指定直连地址（本机通常为 `redis://127.0.0.1:6379/0`），`REDIS_NAMESPACE` 隔离环境，同一环境所有 API、worker 和 maintenance 必须一致；本地调试显式设置 `APP_ENV=development`。在本目录的三个终端分别执行：

```powershell
python -m uvicorn app.main:app --host 127.0.0.1 --port 18088 --no-access-log
python -m app.workers
python -m app.dispatcher
```

首次运行及结构升级前单独执行 `python -m app.migrate`；上述进程只检查数据库兼容性，不自动迁移。后端 Docker 镜像不包含页面；生产官网、管理后台通过 `Dockerfile.static` 独立构建并由 OpenResty 提供。本地 `bootstrap.ps1 -Start` 单独运行两个前端的 npm 构建，并由根 Compose 只读挂载到 API，需安装 Node.js；直接运行 Python 时将官网产物放到 `app/website_dist`，后台产物由现有构建脚本生成。双槽位切换、后台排空和本地演练见[部署规范](../docs/DEPLOYMENT.md)。

## 开发入口

| 范围 | 规范 |
| --- | --- |
| 公开 API | [翻译契约](../docs/READING_TRANSLATION_CONTRACT.md)、[OpenAPI](../contracts/README.md)；运行时 `/docs` 与 `/openapi.json` |
| 任务执行 | [调度](../docs/TRANSLATION_CLUSTER_DESIGN.md)、[计算协议](../docs/COMPUTE_PROTOCOL.md)、[节点配置](../docs/NODE_CONFIGURATION.md) |
| 账户与支付 | [身份](../docs/PRODUCTION_IDENTITY.md)、[会员](../docs/MEMBERSHIP_AND_QUOTAS.md)、[支付](../docs/STRIPE_BILLING.md) |
| 管理与配置 | [后台](../docs/ADMIN_CONSOLE.md)、[系统设置](../docs/SYSTEM_SETTINGS.md)、[文本供应商](../docs/TRANSLATION_PROVIDERS.md)、[配置模板](../.env.example) |
| 存储与运维 | [文件存储](../docs/OBJECT_STORAGE.md)、[备份与恢复](../docs/OPERATIONS.md) |
| 搜索与分析 | [漫画名翻译 API](../docs/COMIC_SEARCH_DESIGN.md)、[GA4 插件使用分析](../docs/ANALYTICS.md) |

## 验证

在仓库根目录运行隔离测试：

```powershell
docker compose -p node-comics-tests -f deploy/compose.tests.yaml up --build --abort-on-container-exit --exit-code-from tests
docker compose -p node-comics-tests -f deploy/compose.tests.yaml down
```

也可安装 [requirements-test.txt](requirements-test.txt)，在本目录执行 `python -m pytest -q tests`。未设置 `TEST_REDIS_URL` 时使用 fakeredis/Lua；设置为专用 Redis 8 测试实例后，验证真实脚本与跨进程共享，每个用例使用随机命名空间并仅清理自身键。PostgreSQL 并发套件需显式设置 `RUN_POSTGRES_CONCURRENCY=1` 和 `TEST_PG_HOST / PORT / USER / PASSWORD`，仅使用 `nodecomics_concurrency_test`；测试 Compose 提供独立临时 PostgreSQL 和 Redis。未启用的用例记为 skipped。

浏览器测试使用 `tests/manual_*_server.py` 的临时库和合成供应商；后端夹具连接 `TEST_REDIS_URL` 指定的 Redis 8（默认本机 6379），使用随机命名空间隔离。启动顺序见[脚本入口](../scripts/README.md)。真实 OIDC、支付和模型效果分别验收。真实文本 LLM + GPU + Docker 入口见 `scripts/verify_overlay_live.py`，仅连接隔离回环 HTTPS 环境。
