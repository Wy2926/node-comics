# 健康监控与隔离恢复

适用当前 Job 结果模型及本地文件存储。涵盖健康信号、数据库与结果文件备份和隔离恢复，数据库切换遵循[部署规范](DEPLOYMENT.md)。

## 健康信号

| 入口 | 含义与失败表现 |
| --- | --- |
| `GET /health`、`GET /health/live` | API 进程能响应；不查询数据库或远端服务 |
| `GET /health/ready` | 检查数据库、Redis、控制进程、维护进程、控制资源池；OIDC 模式另要求近期成功的公共 JWKS 探测，常规翻译启用时另要求在线计算节点；依赖不可用返回 503 |
| `python -m app.health control-worker` | 检查当前容器 PID 1 的控制进程已完成循环，退出码 0/1 |
| `python -m app.health maintenance` | 检查当前容器 PID 1 的维护进程已完成循环，退出码 0/1 |

Compose 已为三个控制服务配置健康检查，每 15 秒一次，启动宽限 60 秒，连续失败 3 次标为 unhealthy。Docker 的 `restart: unless-stopped` 处理进程退出；**unhealthy 本身不会让 Docker 自动重启**，需由部署环境的监控处理。故障恢复循环保留数据库租约和调用意图，不因重新启动而自动重发结果未知的图片调用。

`service_heartbeats` 按角色、主机、PID 保存进展、最近成功时间、连续失败数、累计失败数和脱敏错误码。控制进程在领取循环完成后最多每 5 秒记录一次；维护进程完成租约恢复和文件清理后记录一次，循环卡死不会继续报告成功。失联窗口使用 `CLUSTER_NODE_TIMEOUT_SECONDS`（默认 120 秒）。同角色其他健康副本能维持集群就绪，单容器检查始终检查自己的实例。超过 7 天的历史心跳可删除，不涉及对象或业务记录。

维护进程每 `min(60, CLUSTER_NODE_TIMEOUT_SECONDS / 3)` 秒强制刷新公共 JWKS 并记录 `oidc` 心跳；请求超时使用 `OIDC_JWKS_TIMEOUT_SECONDS`。开发免密码模式跳过探测。健康 HTTP 请求只读数据库并 PING Redis，不调用 OIDC 或模型。该探测验证公钥端点及签名键可读，不能替代浏览器登录、授权端点或令牌换取端到端验收。

`/health/ready` 的 `alerts` 是不含用户、任务 ID 或图片内容的全局数量，每项最多计到 1000：

| 信号 | 报警条件与处理 |
| --- | --- |
| `outcome_unknown` | 大于 0 即需核实上游受理和结果；保留调用记录，不自动重新调用图片模型 |
| `unknown_released` | 大于 0 表示名额已释放但仍待人工核实；检查管理后台核实列表 |
| `overdue_ready_stages` | 连续两次轮询大于 0：检查节点、支持语言、资源池容量及积压；忽略用户主动暂停的队列 |
| `expired_leases` | 连续两次维护周期仍大于 0：检查失联节点、维护心跳及本地文件恢复错误 |

逾期阈值 `overdue_after_seconds` 取 `CLASSIC_TIMEOUT_SECONDS`、`PROVIDER_TIMEOUT_SECONDS`、`3 × CLUSTER_NODE_TIMEOUT_SECONDS` 中最大值。数量封顶由 `count_limit` 声明，1000 表示至少 1000。这些信号用于报警，不把仍能正常服务其他用户的 API 整体判为不可用。监控需同时检查 HTTP 状态与 `alerts`，连续 503 则告警服务故障。

默认异常日志只记录角色、错误码、可用的任务/租约 ID、阶段和最多 8 个栈位置，不输出异常原文、SQL 参数、凭据、签名 URL 或图片文字。线程池完成项会取回异常并记录对应租约，避免静默丢失。维护中到期未知任务、停用供应商任务分别预选至多 100 个候选，取得调度锁后重新核验；回执归档、上传过期也各有批量上限。

仓库 Compose 中的中心服务及自带 Redis／PostgreSQL 诊断日志按每份 10 MiB、最多 3 份轮转，生产外部 PostgreSQL 由既有基础设施管理。Windows 节点诊断日志在 10 MiB 时轮转，保留当前文件及最多 5 份备份。节点 SQLite 恢复数据库只保存活动领取、租约与待确认交付，确认终态后清理并自动回收空闲页；不能用诊断日志轮转策略删除未确认任务。具体节点规则见[节点配置](NODE_CONFIGURATION.md)。

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

恢复报告列出表行数，私有 `object-references.json` 列出尚未清理的本地文件键。有效结果标记为必需，临时输入、未提交结果和已接收的未完成上传标记为可恢复的非必需文件；已清理原图不进入清单，上传路径按 `inputs/<reservation-id>/source` 生成。这些文件不进入普通日志。

数据库备份工具**不包含本地图片文件**，清单标记 `objects_included: false`，恢复报告标记 `objects_verified: false`。完整备份须暂停新流量，排空在途上传/交付并停止三个中心进程，再备份 PostgreSQL 与同一恢复点的 `results/`；排除临时 `inputs/`、`staging/`。公开安装包位于独立的永久下载地址，不进入翻译文件卷备份。原图缺失在恢复后需客户端同摘要补传。恢复时保持维护和清理关闭，按私有引用清单核验结果文件摘要与解码尺寸后才启用服务。不能把单独数据库恢复视为完整灾备，也不能按恢复库中缺失引用删除较新文件。

隔离恢复后先保持 API、控制执行与维护进程关闭，仅检查数据。在线备份后的新任务、额度结算、撤销授权及图片上游调用可能不在快照内，不能直接启动恢复库：需先对照运行记录与上游核实，尤其是所有未终态重绘任务，避免把快照中的排队任务当成尚未调用。生产切换属于单独的受控恢复操作，本工具不替操作者启动服务或重放任务。

## 恢复验证

重复演练使用与 PostgreSQL 并发套件相同的显式 `TEST_PG_*` 环境变量，且要求 `RUN_POSTGRES_CONCURRENCY=1`、`TEST_PG_DATABASE=nodecomics_concurrency_test`。可选 `TEST_PG_CONTAINER` 指向该隔离服务器的容器，输出目录必须不存在：

```powershell
backend/.venv/Scripts/python.exe scripts/verify_database_restore.py `
  --output artifacts/restore-drill-new
backend/.venv/Scripts/python.exe -m pytest backend/tests/test_health.py backend/tests/test_database_backup.py -q
```

演练脚本只创建与删除自身随机前缀的两个数据库，不删除共用测试容器。测试覆盖存活/就绪分离、组件失联、单副本故障、JWKS 探测失败、健康请求不调用外部身份或模型服务、未知/逾期队列告警、日志脱敏、在线快照恢复、拒绝覆盖、损坏备份拒绝与本地文件引用清单。

## 部署验收边界

生产身份校验、公钥撤销、首次登录竞争、请求保护、账户内结果权限和健康检查的现行说明分别见[生产身份](PRODUCTION_IDENTITY.md)、[请求保护](SUBMISSION_SCHEDULING.md)、[文件存储](OBJECT_STORAGE.md)与本文。

部署前检查三个中心进程共享同一持久卷及卷权限。文件卷空间由部署环境保证，不配置应用磁盘容量准入。真实 OIDC 用户／管理员登录、反向代理、目标规模、控制进程告警及数据库/结果配套恢复需在目标部署验收；本地或模拟响应测试不代替这些证据。
