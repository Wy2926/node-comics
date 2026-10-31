# 健康监控与隔离恢复

适用当前 Job 结果模型及本地文件存储。涵盖健康信号、数据库与结果文件备份和隔离恢复，数据库切换遵循[部署规范](DEPLOYMENT.md)。

## 健康信号

| 入口 | 含义与失败表现 |
| --- | --- |
| `GET /health`、`GET /health/live` | API 进程能响应；不查询数据库或远端服务 |
| `GET /health/ready` | 当前 API 的数据库连通性、共享目录权限和 Redis 连通性；返回镜像 release，不依赖后台心跳，不扫描队列或支付数据，不比较迁移版本号，失败 503 |
| `GET /health/cluster` | 检查数据库、Redis、控制进程、维护进程、控制资源池；OIDC 模式另要求近期成功的公共 JWKS 探测，常规翻译启用时另要求在线计算节点；依赖不可用返回 503 |
| `python -m app.health control-worker` | 检查当前容器 PID 1 的控制进程已完成循环，退出码 0/1 |
| `python -m app.health maintenance` | 检查当前容器 PID 1 的维护进程已完成循环，退出码 0/1 |

服务器 Compose 的 API 每 10 秒检查一次，启动宽限 20 秒，连续失败 6 次标为 unhealthy；后台每 15 秒一次、宽限 60 秒、连续失败 3 次。Docker 的 `restart: unless-stopped` 处理进程退出；**unhealthy 本身不会让 Docker 自动重启**，需由部署环境的监控处理。故障恢复循环保留数据库租约和调用意图，不因重新启动而自动重发结果未知的图片调用。

必要表／字段和支付数据环境仅在显式迁移时检查，不阻塞普通进程启动或参与就绪探测。`/health/cluster` 是诊断入口，不作为 API 切流门禁；不兼容的类型、约束或业务语义变化仍按[部署规范](DEPLOYMENT.md)处理。

`service_heartbeats` 按角色、主机、PID 保存进展、最近成功时间、连续失败数、累计失败数和脱敏错误码。控制进程在领取循环完成后最多每 5 秒记录一次；维护进程完成租约恢复和文件清理后记录一次，循环卡死不会继续报告成功。失联窗口使用 `CLUSTER_NODE_TIMEOUT_SECONDS`（默认 120 秒）。同角色其他健康副本能维持集群就绪，单容器检查始终检查自己的实例。超过 7 天的历史心跳可删除，不涉及对象或业务记录。

维护进程每 `min(60, CLUSTER_NODE_TIMEOUT_SECONDS / 3)` 秒强制刷新公共 JWKS 并记录 `oidc` 心跳；请求超时使用 `OIDC_JWKS_TIMEOUT_SECONDS`。开发免密码模式跳过探测。健康 HTTP 请求只读数据库并 PING Redis，不调用 OIDC 或模型。该探测验证公钥端点及签名键可读，不能替代浏览器登录、授权端点或令牌换取端到端验收。

`/health/cluster` 的 `alerts` 是不含用户、任务 ID 或图片内容的全局数量，每项最多计到 1000：

| 信号 | 报警条件与处理 |
| --- | --- |
| `outcome_unknown` | 大于 0 即需核实上游受理和结果；保留调用记录，不自动重新调用图片模型 |
| `unknown_released` | 大于 0 表示名额已释放但仍待人工核实；对照后台任务履历与供应商记录排查 |
| `overdue_ready_stages` | 连续两次轮询大于 0：检查节点、支持语言、资源池容量及积压；忽略用户主动暂停的队列 |
| `expired_leases` | 连续两次维护周期仍大于 0：检查失联节点、维护心跳及本地文件恢复错误 |

逾期阈值 `overdue_after_seconds` 取 `CLASSIC_TIMEOUT_SECONDS`、`PROVIDER_TIMEOUT_SECONDS`、`3 × CLUSTER_NODE_TIMEOUT_SECONDS` 中最大值。数量封顶由 `count_limit` 声明，1000 表示至少 1000。这些信号用于报警，不把仍能正常服务其他用户的 API 整体判为不可用。监控需同时检查 HTTP 状态与 `alerts`，连续 503 则告警服务故障。

默认异常日志只记录角色、错误码、可用的任务/租约 ID、阶段和最多 8 个栈位置，不输出异常原文、SQL 参数、凭据、签名 URL 或图片文字。线程池完成项会取回异常并记录对应租约，避免静默丢失。维护中到期未知任务、停用供应商任务分别预选至多 100 个候选，取得调度锁后重新核验；回执归档、上传过期也各有批量上限。

仓库 Compose 中的中心服务及自带 Redis／PostgreSQL 诊断日志按每份 10 MiB、最多 3 份轮转，生产外部 PostgreSQL 由既有基础设施管理。节点的诊断日志轮转与 SQLite 恢复数据库生命周期见[节点配置](NODE_CONFIGURATION.md)；不能用日志轮转策略删除未确认任务。

## Nginx 访问统计

使用独立 [NginxPulse Compose](../deploy/compose.nginxpulse.yaml)，采用上游原生界面、数据库、增量解析、多站点配置与统计口径；不接入业务数据库、应用发布或健康门禁，不在官网埋点。镜像固定版本与摘要，来源和许可见[依赖说明](../deploy/nginxpulse/THIRD_PARTY.md)。

### 数据与权限

- 面板地址由私密环境文件的 `NGINXPULSE_ORIGIN` 与 `NGINXPULSE_BASE_PATH` 决定，默认 `https://comics.nodelane.net/traffic/`，提供原生概况、日报、实时、访问明细和系统配置。HTTPS Basic Auth 使用专用管理员凭据，所有页面、资源及 API 均鉴权、no-store、noindex；写请求必须来自配置的同源地址。原生配置可修改，不能把这个入口当作只读报表对外分享。
- 每个站点一份脱敏访问日志，使用原生固定站点配置，不按客户端 Host 动态建站，也不把同一请求重复写入分类日志。不记录查询参数、Cookie、Authorization 或正文；任务路径归一化，身份服务路径收敛为 `/:private`。账户、回调、支付、后台和统计页排除；真实后台入口只写入服务器私有 map。保留部署环境已核实的真实 IP 信任链。
- PV、UV、会话、机器人判断及日期筛选遵循 NginxPulse，不另外实现统计算法。初始 `pvFilter` 排除静态资源、API、节点、账单路径和私有占位路径；统计值不等于登录人数、付款或翻译任务数。SSE／长轮询的请求耗时是连接持续时间；源站日志不包含 CDN 未回源命中和浏览器内未发请求的页面切换。
- **地理解析采用上游默认行为**：本地 ip2region 无法匹配时，将 IP 发往 `ip-api.com` 批量补全，默认接口为 HTTP。它不是“完全本地／匿名统计”；上游缓存、访客和会话数据也是受控数据。官网隐私披露与运行环境的数据外发要求须在生产启用前核对。后台任务国家查询仍使用下节的独立本地 MMDB，不调用该接口。
- 容器只读挂载指定访问日志目录，不挂载宿主 Nginx 配置、证书、Docker socket 或业务数据。仅前端端口绑定 `127.0.0.1:${NGINXPULSE_PORT}`（默认 18090），API 8089 和内置 PostgreSQL 不对宿主发布。

### 安装与维护

以下以 Debian/Ubuntu 的 `www-data`、`adm` 为例，先核对本机用户、组与 UID。首次安装：

1. 创建 `/var/log/nginx/nginxpulse`（www-data:adm 0750）和 `/etc/nodelane/nginxpulse`（统计进程 UID:adm 0750）。将[初始配置](../deploy/nginxpulse/nginxpulse_config.json)复制为后者的 `nginxpulse_config.json`，权限 0640；按实际部署保留需要的站点，后续通过原生界面维护，升级时不覆盖此文件。配置目录必须可写，供设置保存。
2. 复制[环境示例](../deploy/nginxpulse/server.env.example)到 `/etc/nodelane/nginxpulse.env`，设置面板 HTTPS origin（无尾斜线）、单段路径（不带斜线、不与业务路由冲突）、未占用的回环端口和进程 UID、日志读取组 GID，以及用 `openssl rand -hex 32` 生成的数据库密码。使用不加引号的字面量 `KEY=value`，不写变量引用或行尾注释。将同一密码填入私密 `nginxpulse_config.json` 的 `database.dsn` 占位处，保持容器内置数据库地址 `127.0.0.1:5432/nginxpulse`，不要连接业务数据库。原生设置保存要求完整 DSN，不能只配置环境变量。环境文件仅管理员可读，两份私密配置均勿提交仓库；不要修改已有数据库密码后期待容器自动重置数据库账户。
3. 创建 `/etc/nodelane/nginxpulse.htpasswd`（root:www-data 0640），使用独立密码。创建 `/etc/nodelane/nginxpulse-private.map`，按[示例](../deploy/nginxpulse/private.map.example)排除实际后台入口；文件必须存在且不提交真实路径。
4. 用下方命令从同一环境文件生成代理配置，将 `nginx.http.conf` 安装到 `/etc/nginx/conf.d/nodelane-nginxpulse.conf`，将 `nginx.dashboard.inc` 安装到 `/etc/nodelane/nginxpulse.dashboard.inc`，仅在面板 origin 对应的 HTTPS server 中 include 后者。按下表为各统计站点安装一份[日志片段](../deploy/nginxpulse/nginx.logs.inc)，替换其中的固定日志文件名。不要覆盖站点现有 TLS、真实 IP 或业务路由；更换统计站点域名时另行调整 HTTP 模板的公开路径白名单。关闭同层其他原始访问日志，避免未脱敏副本。
5. 为错误脱敏创建系统账号 `nodelane-nginx-errors`（主组 www-data），将 [nginx_error_log.py](../scripts/nginx_error_log.py)安装到 `/usr/local/lib/nodelane/`，安装并启动 [nodelane-nginx-errors.service](../deploy/nginxpulse/nodelane-nginx-errors.service)。它只保护日志，不参与统计；脱敏结果在 `/var/log/nodelane-nginx-errors/error.log`，不提供额外报表。
6. 将 [logrotate 配置](../deploy/nginxpulse/logrotate.conf)安装到 `/etc/logrotate.d/nodelane-nginxpulse`，由系统现有定时任务执行。访问日志 rename/create/reopen，不用 copytruncate；每天轮转、保留 7 份并延迟压缩。分析器只跟踪每站活动日志，不使用包含轮转归档的通配符，避免同一记录以新文件路径再次入库；归档用于受控排障，不自动回填。轮询采集与轮转不具备事务保证，轮转前未扫描的尾部可能遗漏，不能作为计费或完整审计依据。此策略不是磁盘容量硬上限，需监控宿主磁盘。

| 站点 | 宿主 `/var/log/nginx/nginxpulse/` 下的文件 |
| --- | --- |
| `comics.nodelane.net` | `comics.access.log` |
| `comics-a.nodelane.net` | `comics-api.access.log` |
| `auth.nodelane.net` | `auth.access.log` |
| `auth-admin.nodelane.net` | `auth-admin.access.log` |

从仓库根目录执行，`--env-file` 指向已准备的私密文件：

```sh
python3 scripts/configure_nginxpulse.py --env-file /etc/nodelane/nginxpulse.env --output /run/nodelane-nginxpulse
install -m 0644 /run/nodelane-nginxpulse/nginx.http.conf /etc/nginx/conf.d/nodelane-nginxpulse.conf
install -m 0644 /run/nodelane-nginxpulse/nginx.dashboard.inc /etc/nodelane/nginxpulse.dashboard.inc
docker compose --env-file /etc/nodelane/nginxpulse.env -f deploy/compose.nginxpulse.yaml config --quiet
docker compose --env-file /etc/nodelane/nginxpulse.env -f deploy/compose.nginxpulse.yaml up -d --wait --wait-timeout 90
nginx -t && systemctl reload nginx
docker compose --env-file /etc/nodelane/nginxpulse.env -f deploy/compose.nginxpulse.yaml ps
```

修改访问地址或端口后重跑上述生成、安装、Compose 和 Nginx 校验/reload 步骤；Compose 将路径传给上游 `WEB_BASE_PATH`，覆盖原生设置，不能只在面板内修改路径。域名需已有对应 DNS、证书和 HTTPS server；脚本不自动修改这些资源。旧路径不保留兼容入口，重载前检查新路径不与官网、后台或语言路由冲突。单段路径限制遵循[上游字段说明](https://nginx-pulse-docs.kaisir.cn/docs/Config-Reference#webbasepath)。

容器内置独立 PostgreSQL，配置目录、`data` 和 `postgres` 卷必须一起保留；停止后备份或采用数据库一致性备份，不用 `down --volumes` 清理生产。默认北京时间、每分钟扫描、入库访问数据保留 30 天；这里保留的是访问明细，不只是匿名聚合。缓存与维表的清理由上游实现负责，不宣称全部 IP 在第 30 天删除。原始日志轮转与数据库清理相互独立。

Compose 初始限制为 1 CPU、1 GiB 内存，属于资源预算而非吞吐保证；历史回填和实际峰值需在目标主机测量。应用失效只影响统计页，不阻断网站。维护日志与配置可能包含 IP、路径或数据库信息，仅在管理员环境查看，不上传公共日志。

验证：`python scripts/tests/test_nginx_support.py` 只保留地址配置、错误脱敏和 GeoIP 原子更新的关键回归。部署后检查匿名页面/资源/API 为 401、认证后为 200，跨源写请求为 403，四站日志能被原生面板读取；检查轮转及容器重启后不重复入库，网站/API 健康与其他业务进程不受影响。不维护上游功能的重复测试框架。

### 管理后台 GeoIP

[update_geoip.py](../scripts/update_geoip.py)只维护后台使用的 DB-IP Lite City，不依赖统计服务，也不下载无消费者的 ASN 库。安装系统 Python 的 `maxminddb`（项目版本见[后端依赖](../backend/THIRD_PARTY.md)），将脚本安装到 `/usr/local/lib/nodelane/`，安装 [service](../deploy/geoip/nodelane-geoip.service) 和 [timer](../deploy/geoip/nodelane-geoip.timer) 后执行：

```sh
systemctl daemon-reload
systemctl enable --now nodelane-geoip.timer
systemctl start nodelane-geoip.service
```

数据库位于 `/var/lib/nodelane-geoip/city.mmdb`，目录／文件权限 755／644，API 只读挂载整个目录。每天检查月度发布，下载并验证后原子替换；来源、月份、SHA-256 和 CC BY 4.0 许可保存在 `sources.json`。已有部署切换挂载前先准备并验证新目录，不能给运行中的 API 挂空目录。完整后台行为见[任务 IP 与国家](ADMIN_CONSOLE.md#任务-ip-与国家)。

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

隔离恢复后先保持 API、控制执行与维护进程关闭，仅检查数据。在线备份后的新任务、额度结算、撤销授权及文本上游调用可能不在快照内，不能直接启动恢复库：需先对照运行记录与上游核实，尤其是所有未终态文本调用，避免把快照中的排队任务当成尚未调用。生产切换属于单独的受控恢复操作，本工具不替操作者启动服务或重放任务。

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
