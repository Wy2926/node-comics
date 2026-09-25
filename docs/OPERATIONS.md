# 健康监控与隔离恢复

适用当前 `translations_0001` 新空库基线。涵盖健康信号、数据库备份和隔离恢复。

## 健康信号

| 入口 | 含义与失败表现 |
| --- | --- |
| `GET /health`、`GET /health/live` | API 进程能响应；不查询数据库或远端服务 |
| `GET /health/ready` | 检查数据库、控制进程、维护进程、控制资源池；OIDC 模式另要求近期成功的公共 JWKS 探测，常规翻译启用时另要求在线计算节点；依赖不可用返回 503 |
| `python -m app.health control-worker` | 检查当前容器 PID 1 的控制进程已完成循环，退出码 0/1 |
| `python -m app.health maintenance` | 检查当前容器 PID 1 的维护进程已完成循环，退出码 0/1 |

Compose 已为三个控制服务配置健康检查，每 15 秒一次，启动宽限 60 秒，连续失败 3 次标为 unhealthy。Docker 的 `restart: unless-stopped` 处理进程退出；**unhealthy 本身不会让 Docker 自动重启**，需由部署环境的监控处理。故障恢复循环保留数据库租约和调用意图，不因重新启动而自动重发结果未知的图片调用。

`service_heartbeats` 按角色、主机、PID 保存进展、最近成功时间、连续失败数、累计失败数和脱敏错误码。控制进程在领取循环完成后最多每 5 秒记录一次；维护进程完成租约恢复和授权清理后记录一次，循环卡死不会继续报告成功。失联窗口使用 `CLUSTER_NODE_TIMEOUT_SECONDS`（默认 120 秒）。同角色其他健康副本能维持集群就绪，单容器检查始终检查自己的实例。超过 7 天的历史心跳可删除，不涉及对象或业务记录。

维护进程每 `min(60, CLUSTER_NODE_TIMEOUT_SECONDS / 3)` 秒强制刷新公共 JWKS 并记录 `oidc` 心跳；请求超时使用 `OIDC_JWKS_TIMEOUT_SECONDS`。开发免密码模式跳过探测。健康 HTTP 请求只读数据库，不调用 OIDC、R2 或模型。该探测验证公钥端点及签名键可读，不能替代浏览器登录、授权端点或令牌换取端到端验收。

`/health/ready` 的 `alerts` 是不含用户、任务 ID 或图片内容的全局数量，每项最多计到 1000：

| 信号 | 报警条件与处理 |
| --- | --- |
| `outcome_unknown` | 大于 0 即需核实上游受理和结果；保留调用记录，不自动重新调用图片模型 |
| `unknown_released` | 大于 0 表示名额已释放但仍待人工核实；检查管理后台核实列表 |
| `overdue_ready_stages` | 连续两次轮询大于 0：检查节点、支持语言、资源池容量及积压；忽略用户主动暂停的队列 |
| `expired_leases` | 连续两次维护周期仍大于 0：检查失联节点、维护心跳及对象存储恢复错误 |

逾期阈值 `overdue_after_seconds` 取 `CLASSIC_TIMEOUT_SECONDS`、`PROVIDER_TIMEOUT_SECONDS`、`3 × CLUSTER_NODE_TIMEOUT_SECONDS` 中最大值。数量封顶由 `count_limit` 声明，1000 表示至少 1000。这些信号用于报警，不把仍能正常服务其他用户的 API 整体判为不可用。监控需同时检查 HTTP 状态与 `alerts`，连续 503 则告警服务故障。

默认异常日志只记录角色、错误码、可用的任务/租约 ID、阶段和最多 8 个栈位置，不输出异常原文、SQL 参数、凭据、签名 URL 或图片文字。线程池完成项会取回异常并记录对应租约，避免静默丢失。维护中到期未知任务、停用供应商任务分别预选至多 100 个候选，取得调度锁后重新核验；回执归档、上传过期也各有批量上限。

## 数据库备份

运行环境：仓库 `backend/.venv` 的 Python 及依赖；PostgreSQL 17 使用同主版本 `pg_dump` / `pg_restore`。Windows 没有客户端时，可用 `--pg-container` 指定当前 PostgreSQL 容器，由容器内工具连接自身 5432 端口；主机 URL 必须指向同一容器的本机回环映射端口。工具先核验 Docker 端口绑定，再比较两个连接的 PostgreSQL `system_identifier` 和服务启动时间；身份不一致或无法查询时拒绝执行，也不会创建恢复库。账号需能连接 `postgres` 库并读取 `pg_control_system()`。不要将该选项用于其他数据库服务器。

先通过秘密管理向当前进程注入 `BACKUP_DATABASE_URL`，命令不输出 URL，不自动加载业务 `.env`。备份目录必须不存在：

```powershell
backend/.venv/Scripts/python.exe scripts/database_backup.py backup `
  --database-env BACKUP_DATABASE_URL `
  --directory D:/private-backups/node-comics/backup-new `
  --pg-container <当前 PostgreSQL 容器名>
```

输出 PostgreSQL custom dump 和 `manifest.json`（时间、格式、大小、SHA-256）。只有备份及格式检查完成才写清单；不覆盖已有目录、不删除旧备份。备份包含身份、权益、账本及对象键，应保存于受控目录，并由部署环境加密、复制至独立备份介质。建议每日备份、每月隔离恢复演练，具体周期由部署环境配置。

隔离 SQLite 验证使用在线 backup API，而非复制正在使用的 `.db` 文件：

```powershell
backend/.venv/Scripts/python.exe scripts/database_backup.py backup `
  --sqlite D:/isolated/source.db --directory D:/isolated/backup
```

## 隔离恢复

向 `RESTORE_DATABASE_URL` 注入**新数据库**连接地址。PostgreSQL 目标名必须为 `nodecomics_restore_*`；工具检查目标不存在、创建空库、在单个事务内恢复，并检查表可读、约束已验证。没有覆盖、清库或切换线上连接的选项。SHA-256 校验失败时不会创建目标库。

```powershell
backend/.venv/Scripts/python.exe scripts/database_backup.py restore `
  --database-env RESTORE_DATABASE_URL `
  --directory D:/private-backups/node-comics/backup-new `
  --reference-output D:/private-backups/node-comics/restored-object-references.json `
  --pg-container <当前 PostgreSQL 容器名>
```

SQLite 目标必须为不存在的 `restore-*.db` / `restore-*.sqlite3`，恢复后执行完整性和外键检查：

```powershell
backend/.venv/Scripts/python.exe scripts/database_backup.py restore `
  --sqlite D:/isolated/restore-drill.db --directory D:/isolated/backup
```

恢复报告列出表行数，私有 `object-references.json` 列出快照中去重的有效授权对象键、待提交译图与未完成上传键。这些文件不进入普通日志。

数据库备份**不包含 R2 图片字节**，清单明确 `objects_included: false`，恢复报告明确 `objects_verified: false`。共享原图、译图不会因某用户撤销授权或数据库缺少引用而被后台自动删除，因此正常数据库恢复可继续引用保留对象；这不防范桶级删除或存储故障。完整灾备仍需独立对象备份，恢复后按私有引用清单核验字节摘要及可解码性。进行中的上传对象可能尚未 PUT，检查时需区别上传未完成和已交付资源缺失。当前工具不读取、修改或扫描 R2。

隔离恢复后先保持 API、控制执行与维护进程关闭，仅检查数据。在线备份后的新任务、额度结算、撤销授权及图片上游调用可能不在快照内，不能直接启动恢复库：需先对照运行记录与上游核实，尤其是所有未终态重绘任务，避免把快照中的排队任务当成尚未调用。生产切换属于单独的受控恢复操作，本工具不替操作者启动服务或重放任务。

## 恢复验证

重复演练使用与 PostgreSQL 并发套件相同的显式 `TEST_PG_*` 环境变量，且要求 `RUN_POSTGRES_CONCURRENCY=1`、`TEST_PG_DATABASE=nodecomics_concurrency_test`。可选 `TEST_PG_CONTAINER` 指向该隔离服务器的容器，输出目录必须不存在：

```powershell
backend/.venv/Scripts/python.exe scripts/verify_database_restore.py `
  --output artifacts/restore-drill-new
backend/.venv/Scripts/python.exe -m pytest backend/tests/test_health.py backend/tests/test_database_backup.py -q
```

演练脚本只创建与删除自身随机前缀的两个数据库，不删除共用测试容器。测试覆盖存活/就绪分离、组件失联、单副本故障、JWKS 探测失败、健康请求不触网、未知/逾期队列告警、日志脱敏、在线快照恢复、拒绝覆盖、损坏备份拒绝与共享对象清单去重。

## 部署验收边界

生产身份校验、公钥撤销、首次登录竞争、请求保护、共享对象权限和健康检查的现行说明分别见[生产身份](PRODUCTION_IDENTITY.md)、[请求保护](SUBMISSION_SCHEDULING.md)、[对象存储](OBJECT_STORAGE.md)与本文。

部署前检查 R2 公开域名和 r2.dev 均已关闭。真实 OIDC 用户／管理员登录、反向代理与下载 CORS、目标规模容量、控制进程告警及桶级灾备需在目标部署验收；本地或模拟响应测试不代替这些证据。
