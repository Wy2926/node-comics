# 构建与部署

部署输入为当前源码、锁文件和环境配置。公开服务使用私有 R2、OIDC、PostgreSQL 和 Redis 8；数据库由 `translations_0001` 基线升级至 `quota_campaigns_0006`。安装与运行入口见[后端](../backend/README.md)、[插件](../apps/extension/README.md)及[计算节点](../services/compute-node/README.md)。

## 控制服务与官网

1. 核对目标服务、数据库、镜像和代理配置，按[运维规范](OPERATIONS.md)备份。首次部署准备专用空库；数据库不兼容时先确定数据处置，不能以镜像回退代替数据库恢复。
2. 以 `backend/Dockerfile` 构建新的版本标签；镜像同时包含 API、官网和管理后台。保留原标签以便回退。
3. 使用 [compose.server.yaml](../deploy/compose.server.yaml)：`.env` 提供 `SERVER_IMAGE`、端口和网络；`.env.server` 提供应用配置，模板见 [环境示例](../deploy/.env.server.example)。配置文件限运行账号读取。
4. 在部署目录执行：

```sh
docker compose --env-file .env -f compose.server.yaml config --quiet
docker compose --env-file .env -f compose.server.yaml run --rm --no-deps api python -m app.config --production
docker compose --env-file .env -f compose.server.yaml run --rm --no-deps api python -c 'from app.db import initialize; initialize()'
docker compose --env-file .env -f compose.server.yaml up -d
docker compose --env-file .env -f compose.server.yaml ps
curl --fail https://comics.nodelane.net/health/ready
```

反向代理使用 [OpenResty 模板](../deploy/openresty.comics.conf)，保留 API／私有后台路由优先级、缓存和 CSP；关闭图片磁盘缓冲与包含授权参数的访问日志。API 端口仅绑定宿主机回环地址，基础设施局域网只允许可信控制服务，API 信任该边界内的代理头。OpenResty 仅信任 Cloudflare 官方公布的 IPv4／IPv6 网段，通过 `real_ip_header CF-Connecting-IP` 恢复客户端地址，再用 `$remote_addr` 覆盖外部传入的 `X-Forwarded-For` 和 `X-Real-IP`；来自其他地址的请求不能借这些头伪造来源。Cloudflare 网段变更时复核信任清单，更新后检查代理配置并重载。OIDC 回调配置见[身份规范](PRODUCTION_IDENTITY.md)。GA4 中继与隐私政策先于插件上线，依赖与顺序见[分析规范](ANALYTICS.md#中继与发布)。

官网与后台静态资源分别由 API 镜像中的 `app/website_dist`、`app/admin_web/dist` 提供。单独更新其一时，以实际运行 API 镜像为基础，仅替换对应目录，保留后端和其他资源；核对目标 Compose 后只重建 API。失败时恢复原镜像配置。公开 HTML 可能被 CDN 注入，验收使用内容、资源与交互，不只比较 HTML 哈希。

赠送顺延的 `gift_renewal_0005` 只新增用户与订阅所需字段，不转换旧交易数据。既有运营会员保留 `plus_timezone`、原额度 ID 与日历月周期；新会员段使用 30 天周期。升级前停止旧 API、worker 和 maintenance，完成结构升级后统一启动同版本服务，避免旧进程忽略已安排的延期。账户、漫画、任务与历史额度保留。仍有续费延期操作或未结束的 30 天赠送时禁止回退到旧会员代码。

额度活动的 `quota_campaigns_0006` 新增配置与用户领取回执，并允许赠送桶没有到期时间；原有额度、已用／预占和账本保持不变。备份后停止全部旧控制进程，迁移并统一启动兼容代码，再通过管理员活动接口配置、启用和核对已发人数。迁移不自动发放。已有活动配置或无到期赠送时禁止降级；应暂停活动处理问题，不能删除回执重跑或启动旧额度代码。账户接口的 `expires_at`、`next_expiry_at` 允许 `null`，客户端不可将空值格式化为日期。

## Redis 与准入迁移

根 Compose 和服务器 Compose 均提供 Redis 8.2 服务，不发布公网端口。服务器部署使用专用内部网络，只允许本项目控制服务访问。Redis 开启 AOF、每秒刷盘、默认 256 MiB 内存上限和 `noeviction`；可通过 Compose 的 `REDIS_MAX_MEMORY` 调整容量。数据卷必须保留，不能使用淘汰策略随意删除仍有效的并发令牌。AOF 每秒刷盘仍可能在异常断电时丢失最近一秒短期状态，用户页数与结算始终以 PostgreSQL 为准。

Compose 固定 Docker 官方 `redis:8.2-alpine` 镜像摘要，包含 Redis 8.2.10；摘要保留在三个 Compose 文件中。来源为 [Redis](https://github.com/redis/redis)，Redis 8 提供 AGPLv3／RSALv2／SSPLv1 三种许可选择，参见[官方许可](https://redis.io/legal/licenses/)。Python 客户端 redis-py 8.1.0 使用 MIT，fakeredis 2.38.0 仅用于测试并使用 BSD-3-Clause；版本、来源和发行摘要保留在依赖文件中。

`REDIS_URL` 为 redis-py 直接连接的 `redis://` 或 `rediss://` 地址，服务器模板默认 `redis://redis:6379/0`。API、control-worker、maintenance 必须连接同一实例、数据库编号和 `REDIS_NAMESPACE`；生产、测试及沙箱使用不同实例或命名空间。外部 Redis 需通过私网、凭据或 TLS 限制访问，地址和密钥仅保留在后端环境配置。

从数据库准入切换时，先停止新流量，等待在途上传完成，再停止全部旧 API、worker 和 maintenance。准备 Redis 及持久卷，使用新镜像执行数据库迁移后统一启动全部控制服务；不能新旧版本混跑。`redis_admission_0004` 删除分钟计数、反馈／公开申请限流及上传门禁表；持久任务、上传回执、漫画名缓存、审计、额度和调用成本不变。首次切换的短期窗口和当日反馈／公开申请计数从空 Redis 开始；正常服务重启保留 Redis 卷，不能反复清空以绕过限制。

数据库备份不包含 Redis。恢复或回退时先停止流量并排空正在执行的短期请求，再处理对应版本的数据库与 Redis；旧二进制不能直接运行在已删除准入表的新结构上。通过 `/health/ready` 的 `redis` 项核实连接，然后验收不同 API 副本之间的限流、上传续租和故障恢复。算法及异常语义见[请求保护](SUBMISSION_SCHEDULING.md)。

## 插件安装包

1. 在 `apps/extension` 设置正式 `VITE_API_BASE`、`VITE_DRIVE_CONNECT_URL`，更新版本并完成 `npm run check`、`npm test`。
2. 分别生成 Chrome／Edge 手动安装包与无 `manifest.key` 的商店包。Firefox 审核包运行 `npx --no-install web-ext lint --source-dir .output/firefox-mv3`；公开下载使用 AMO 已签名 XPI。
3. 在 [extension-release.json](../backend/extension-release.json) 追加平台、版本、文件名、大小和 SHA-256；保留已有下载地址，更新 `current` 与 `current_by_browser` 中各浏览器已就绪的版本。Firefox 新版尚未取得 AMO 签名时，保留其上一已签名版本并在更新日志中说明。
4. 使用后端 Python 依赖并注入目标 R2 配置，从仓库根目录运行：

```powershell
python scripts/upload_extension_release.py --browser <chrome|edge|firefox> --zip <安装包路径> --manifest backend/extension-release.json
```

脚本核验包身份及正式 API，Firefox 另核对 AMO 官方摘要与签名；上传不可覆盖并回读核对哈希。重新部署后端与官网以更新下载目录。商店提交包不放入手动下载目录。

## 上线检查

- 核对镜像、数据库、控制进程、节点版本与心跳，确认 `/health/ready`。
- 实际完成 OIDC 登录、R2 授权读写、插件阅读与翻译；支付按配置渠道独立验证。R2 公开入口应关闭。
- 检查五语页面、商店入口与平台下载。设置 `WEBSITE_PREVIEW_URL` 后运行 `node scripts/verify_website_download.mjs`，核对包文件名、大小与摘要。
- 运行记录保存在部署环境或忽略的产物目录；仓库文档只维护流程。
