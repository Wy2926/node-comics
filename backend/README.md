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

## 漫画名翻译 API

`POST /v1/comic-titles/translate`，使用登录 Bearer Token。请求示例：

```json
{"name":"进击的巨人","target_language":"en-US"}
```

返回 `{"name":"Attack on Titan","target_language":"en"}`（已有名称由 LLM 选择）。漫画名限制 1–60 个 Unicode 字符，不接受空白名称或控制字符。语言代码仅校验格式，不做白名单限制或本地映射，原样交给 LLM。模型仅选择有把握的既有常用译名或别名，不自行自然翻译、直译或创造音译。目标语言没有对应名称时，按读者接受习惯选择已有的相近语言或英语名称，中日韩优先选择对应语言的已有名称；没有把握或无合适名称时返回 `{"name":null,"target_language":null}`。响应的 `target_language` 是 LLM 返回的实际语言代码。

普通登录用户与 PLUS 均可用，不扣翻译页数额度，无每日或累计次数限制。每用户滚动 60 秒内最多 30 次，缓存命中、无匹配名称和模型失败也计次；超限返回 429 和 `Retry-After`。限速状态存数据库，各 API 进程共享。在后台“翻译供应商”中通过“用于漫画名”独立选择供应商，与正文默认选择互不影响，配置边界见[文本供应商](../docs/TRANSLATION_PROVIDERS.md)。通过 LLM 选择已有的本地化名称或常用别名；结果依赖模型知识，不保证是官方名称。未命中缓存且漫画名供应商不可用时返回 503，模型调用失败或响应无效返回 502，不在请求内自动重试。模型输出仅接受固定 JSON：两个字段必须同时为字符串或同时为 null，拒绝额外字段、Markdown 和格式错误。

每个 API 进程使用独立的 8 个漫画名查询执行位，覆盖数据库操作、缓存等待与模型调用，不占公共 API 线程池。满额时立即返回 503 `COMIC_TITLE_BUSY` 和 `Retry-After: 1`，不排队、不创建缓存租约，也不计入用户分钟次数。多进程各自限制容量；这不是供应商的全局 RPM 限制。HTTP 仍等待本次结果，等待被取消时，已开始的调用继续持有执行位直到完成；服务关闭时等待已接收的调用结束。

缓存使用单表 `comic_title_cache`，保存输入名称、请求语言、返回名称、实际语言和生成结果的 `created_by` 用户 ID。所有登录用户共享；用户 ID 仅记录来源，不参与查询、匹配或权限筛选，命中时不更新生成者，也不记录访问用户。

先按输入名称和目标语言查询；输入为已有返回名时，沿已保存的输入／输出名称对应关系查找其他语言结果，不创建漫画实体或合并记录。名称仅去首尾空白并统一 Unicode NFC，不模糊匹配；语言代码仅忽略大小写，不推断地区回退。多个已有返回名冲突时交给 LLM 判断。直接命中为一次只读查询，输出名反查最多两次只读查询，输入键／语言、输出键均有索引。

`null` 按名称和目标语言持久缓存，不扩展到所有语言；网络、格式和供应商错误不缓存。切换供应商或模型不清除缓存。同一输入名称和语言的并发请求由该记录的租约去重，等待超过 10 秒返回 503 `COMIC_TITLE_PENDING` 和 `Retry-After: 1`。调用期间每 30 秒将有效租约续至数据库当前时间之后 210 秒，覆盖完整模型调用及结果保存；进程中断后租约自然过期，可重新领取。过期或已被接管的租约不能续期或写入结果，原请求返回 503 `COMIC_TITLE_LEASE_LOST`。新迁移 `comic_titles_0002` 在启动时创建缓存表及漫画名供应商选择标记，保留已有业务数据；升级后需在后台选择漫画名供应商。

## 验证

在仓库根目录运行隔离测试：

```powershell
docker compose -p node-comics-tests -f deploy/compose.tests.yaml up --build --abort-on-container-exit --exit-code-from tests
docker compose -p node-comics-tests -f deploy/compose.tests.yaml down
```

也可安装依赖后，在本目录执行 `python -m pytest -q tests`。PostgreSQL 并发套件需显式设置 `RUN_POSTGRES_CONCURRENCY=1` 和 `TEST_PG_HOST / PORT / USER / PASSWORD`，仅使用 `nodecomics_concurrency_test`；测试 Compose 提供独立临时库。未启用的用例记为 skipped。

浏览器测试使用 `tests/manual_*_server.py` 的临时库和合成供应商，启动顺序见[脚本入口](../scripts/README.md)。真实 OIDC、R2、支付和模型效果分别验收。
