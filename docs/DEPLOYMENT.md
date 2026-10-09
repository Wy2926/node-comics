# 构建与部署

部署输入为当前源码、锁文件和环境配置。公开服务使用共享持久文件卷、OIDC、PostgreSQL 和 Redis 8；数据库由 `translations_0001` 基线升级至 `quota_purchases_0014`，支持独立购买页数与套餐服务档位，资产 MIME 列保留 128 字符以保存分块格式。安装与运行入口见[后端](../backend/README.md)、[插件](../apps/extension/README.md)及[计算节点](../services/compute-node/README.md)。

## 发布边界

| 部分 | 生命周期 |
| --- | --- |
| PostgreSQL、统一 Redis、图片卷、基础设施网络 | 外部常驻资源，应用发布不创建、不重启、不清空 |
| API blue / green | 两个回环端口，独立镜像，OpenResty 只向活动槽位发送新流量 |
| control-worker、maintenance | 独立镜像配置和更新；maintenance 单活交接 |
| 数据库迁移 | 显式 `python -m app.migrate`，不随服务启动执行 |
| 官网、管理后台 | 独立静态构建，由 OpenResty 直接读取，不进入 Python 镜像 |

使用 [服务器 Compose](../deploy/compose.server.yaml)；从 [server.env.example](../deploy/server.env.example) 准备 `.env`，从 [应用配置模板](../deploy/.env.server.example) 准备 `.env.server`。配置限运行账号读取。每个角色使用不可变镜像标签或摘要；构建时 `--build-arg RELEASE_ID=<版本>` 写入镜像身份，不能在运行环境伪装成另一个版本。

服务器 Compose **没有 Redis 服务、Redis 卷或 Redis 管理命令**。`REDIS_URL` 指向服务器已有实例；所有槽位和后台进程必须使用同一数据库编号与 `REDIS_NAMESPACE`。通过私网、ACL 或 TLS 限制访问；运行时只执行业务命令和 PING，不修改统一实例的 AOF、内存等配置，也不执行 FLUSH。准入要求 `noeviction`，上线前由实例管理员核实；命名空间不能代替容量隔离。恢复 Redis 丢失的短期状态前须排空仍存活的请求，不能清空令牌后让新旧请求同时重入。用户额度与结算仍以 PostgreSQL 为准。

根 Compose 仅用于本地开发，测试／演练使用独立临时 Redis，不连接生产实例。测试镜像摘要、redis-py 和 fakeredis 来源许可见配置及依赖文件；Redis 来源为 [官方仓库](https://github.com/redis/redis)，许可见[官方说明](https://redis.io/legal/licenses/)。

所有控制进程挂载同一外部图片卷，`TRANSLATION_VOLUME` 必须填写实际在用的 Docker 卷名；不要将升级变成新建空卷。UID 10001 可写，输入、结果和接收暂存均在 `/data/translation`。部署负责磁盘容量，备份同时覆盖数据库和结果目录，见[存储规范](OBJECT_STORAGE.md)。首次安装才由运维预建网络、专用空库和文件卷。

## 本地 Creem 手动验收

[独立测试 Compose](../deploy/compose.creem-test.yaml) 提供官网/API、后台处理进程、PostgreSQL、Redis、受限网关和 Cloudflare Quick Tunnel；不使用根 `.env`、已有沙盒、线上数据库或供应商凭据。配置从 [测试模板](../deploy/creem-test.env.example) 复制到忽略的 `deploy/.env.creem-test`，文件限本机运行账号读取。`APP_ENV=test`、`DEV_AUTH=false`、Creem test、禁用 Stripe/匿名体验/分析/管理入口均在 Compose 固定。只有网关绑定 `127.0.0.1:28088`，数据库、API和隧道 metrics 不发布宿主端口；公网关闭开发认证、管理/计算接口、健康详情及 API 文档，关闭访问日志并加 noindex。

此环境用于真实 OIDC 和 **Creem 测试付款**，不接入正式 GPU 或文本供应商。不能把购买到账验收等同于真实翻译扣减验收；后者需另外接入专用计算节点。Quick Tunnel 不支持 SSE、重启后地址变化，适用于本次支付/账户手测，不作为长期环境。限制见 [Cloudflare 官方说明](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)。

从仓库根目录运行，保留原有沙盒：

```powershell
$testCompose = @('compose', '--env-file', 'deploy/.env.creem-test', '-f', 'deploy/compose.creem-test.yaml')
npm --prefix backend/website run build
docker @testCompose build api
docker @testCompose up -d postgres redis gateway tunnel
docker @testCompose logs tunnel
docker @testCompose run --rm migrate
```

取得当前 HTTPS 隧道 origin 后，完成以下配置再启用付款：

- Logto 现有应用只追加精确 `<origin>/auth/callback/` Redirect URI 和 `<origin>` CORS allowed origin；保留已有回调，不修改刷新期限或退出策略。
- 在 **Creem test API** 创建本环境独立的 `POST /webhooks/creem` 地址，订阅服务端 `CREEM_EVENTS` 中的事件，将返回的签名密钥只存 `CREEM_WEBHOOK_SECRET`。不修改其他环境的 Webhook。远端创建结果不明时先按名称/URL查询，不能盲目重试。参见 [Creem Webhook API](https://docs.creem.io/api-reference/endpoint/create-webhook)。
- `CORS_ORIGINS` 加入该 origin；`CREEM_RETURN_URL=<origin>/payment/success/`。核对测试 API key、签名密钥和回调后设置 `CREEM_ENABLED=true`。
- 准备四个无试用、USD 商品：Lite 月付599美分、年付5999美分，100页永久包和50页30天包各599美分。两个额度包为 `onetime/once`；页数、有效期、Lite档位和每小时1200页在本地目录定义，不从远端商品名称推断。四个 ID 填入模板对应项。

```powershell
docker @testCompose up -d --no-build api control-worker maintenance
docker @testCompose exec -T api python /app/scripts/seed_creem_test_catalog.py
docker @testCompose ps
```

初始化脚本仅接受 `nodecomics_creem_manual_test` 专库，先核对四个真实测试商品，再复用正式目录接口发布；本地写入原子提交，重复运行不发额度、不创建付款、不修改已有订单。测试价格只在此库可见。每次更换隧道地址须同步 Logto、Webhook URL 和本地返回地址，并重建三个后端进程；不要重启仍在手测的 tunnel。只改静态页面时重建官网并刷新浏览器，无需换隧道。

手测从 `<origin>/pricing/` 开始：登录 → 购买永久或限期额度包 → 在托管页面确认 Test Mode 后使用 [Creem 官方测试卡](https://docs.creem.io/api-reference/introduction#test-cards) → 返回账户刷新 → 核对页数、档位和有效期 → 重复刷新不重复到账；另测取消/失败恢复、月/年订阅、会员期间再次购包及退出重开登录。不要使用真实银行卡。真实签名支付回调与人工发送的签名连通探针须分开记录，不能以探针代替付款验收。

暂停使用 `docker @testCompose stop`（保留测试数据）；不执行 `down -v`。重开 tunnel 会换地址，须重新核对上述回调。停用时可在 Creem 关闭本环境独立 Webhook，不影响其他测试或正式回调。

## 迁移与兼容性

运行进程只检查结构、支付环境、文件目录权限和 Redis 连通性，不改表、不写默认配置。显式迁移命令同时初始化缺失的供应商、控制池、系统设置和计费目录；不重置已配置值。PostgreSQL 迁移保留 advisory lock，锁等待超过 5 秒失败，禁止无限阻塞线上请求。

当前运行代码仅接受 `quota_purchases_0014`，允许的结构版本在 [runtime.py](../backend/app/runtime.py) 中显式维护。普通同结构、同任务／结算语义的发布无需迁移。新增结构也不自动视为兼容：必须先审核新旧读写和回退，必要时先发布接受两版结构的桥接版本。未完成兼容验证的结构、协议或结算变更走维护窗口，不通过环境开关跳过检查。分块产物的 MIME 超过旧列上限，不能通过缩短字段或截断值回退；回滚需恢复一致的代码、数据库和文件备份。

购买额度升级采用维护窗口，不增加旧支付数据转换、双写或混跑桥接。先备份、阻止新受理并排空旧控制进程，再迁移并更新 API、maintenance、dispatcher；购买记录、原预占和账本必须一起保留。客户端读取新增购买字段，已安装旧插件仍只看到订阅报价；完整购买和余额展示需要新版插件。即使没有正式生产订单，也不清空用户、任务、赠送或全库；测试支付数据如需重置，必须另行核定环境、精确订单及引用关系，迁移本身不执行清空。

套餐路由迁移为 `translation_providers` 新增可空的 `text_plan_ids`，已有供应商仍适用于全部套餐，不改模型版本、任务快照或缓存。隔离备份库验证迁移后，停止新受理、排空并停止旧控制进程，再显式迁移、更新全部 API／worker／maintenance 和管理后台，最后设置各模型适用套餐。旧代码不执行套餐筛选，启用限制后不能与新版混跑；不提供删除限制字段的 downgrade，回退须恢复经审核的一致备份。

小时限额迁移只为不可变套餐权益版本新增可空字段，不改历史价格、授权或额度。上线前在隔离备份库验证数据与重复迁移，阻止新受理、排空并停止旧控制进程，再迁移和更新全部进程。Lite 发布前可使用已验证且接受新结构的旧业务备用镜像；Lite 开放购买后旧业务不执行小时限制，禁止只回退旧镜像。迁移不提供删除已售限制字段的 downgrade；回退需匹配业务与付款数据。先验证新版，再绑定发布 Lite、停售 PLUS，最后切换官网。

从早于当前基线的系统升级时，先备份并在隔离库演练，使用旧服务排空／核实活动、结果未知与 `unknown_released` 任务，再停止所有旧控制进程并显式迁移。调度、Job 结果、会员顺延、活动额度及 Redis 准入的旧代码不能混跑，也不能仅回退镜像；回退依赖配套数据库和文件备份。旧远端结果授权不恢复，历史 R2 图片不搬运、不删除；当前 UUID、检查点与账本由迁移规则保留。

迁移只在首次安装或已审核的结构升级时执行，不放入普通切流脚本：

```sh
docker compose --env-file .env -f compose.server.yaml --profile migration config --quiet
docker compose --env-file .env -f compose.server.yaml run --rm --no-deps migrate python -m app.config --production
docker compose --env-file .env -f compose.server.yaml run --rm --no-deps migrate
```

当前翻译协议为 overlay-v1，插件从 0.8.0 提供，节点使用 v3。协议切换必须先发布兼容客户端及真实下载入口；Firefox 兼容签名包未就绪时不得继续把旧包当作升级入口。规则见[翻译契约](READING_TRANSLATION_CONTRACT.md)。

## API 切流与回退

在仓库构建 `docker build --build-arg RELEASE_ID=<版本> -t <镜像:版本> backend`，提前传输镜像并准备配置。只修改非活动槽位对应的镜像配置，再按服务名启动，不能执行项目级 `down` 或无差别 `up`：

```sh
docker compose --env-file .env -f compose.server.yaml up -d --no-deps --wait api-green
curl --fail http://127.0.0.1:18089/health/ready
```

`/health/ready` 检查当前 API 实例可接流量且返回镜像 `release`；`/health/cluster` 单独检查后台、OIDC、计算节点和积压。两者均须验收；API 候选不能用旧 worker 心跳冒充新版后台健康。后台容器的健康命令检查自己的实例，发布还需检查其实际镜像摘要。

首次接入时保留现有 TLS、Cloudflare 信任清单和 Picker 文件。安装 [OpenResty 模板](../deploy/openresty.comics.conf) 与 [API 转发片段](../deploy/openresty.api.inc)，后者在容器内为 `/www/node-comics/openresty.api.inc`。当前服务器已将 `/opt/1panel/www` 挂载到 `/www`，静态根使用 `/opt/1panel/www/node-comics`，无需重建代理容器。其他环境也应挂载整个目录，不逐个绑定 `.inc` 文件，否则原子替换后容器可能仍看到旧 inode。准备 `active/api.inc`（[示例](../deploy/api-active.inc.example)）、`active/website.inc`、`active/admin.inc` 后校验并 reload；禁用后台时 `admin.inc` 为空。首次拆分代理也须先在隔离环境验证全部路由，不能直接覆盖生产配置。

以后只替换活动 include。下列路径是宿主机挂载目录，容器名必须用实际值；脚本在代理宿主机运行：

```sh
python scripts/switch_release.py api --port 18089 --release <新版本> --previous-release <旧版本> \
  --active-file /opt/1panel/www/node-comics/active/api.inc \
  --probe-url https://comics.nodelane.net/health/ready --openresty-container <实际容器名>
```

脚本检查候选就绪和旧版本、取得发布互斥锁、原子替换 include、执行配置检查与 reload，再核验经过代理的版本。失败自动恢复原 include 并再次 reload／核验；恢复失败明确报错，不宣称回退成功。上一个配置保留在 `.previous`，它不是数据库备份。原生安装可改用 `--nginx-bin <绝对路径>`。健康 URL 禁止 CDN 缓存；若 CDN 绕过规则不确定，应通过受信任的直连域名验收。

切回旧版使用相同命令，将 `--port / --release / --previous-release` 对调；先检查旧 API 仍然就绪且结构兼容。脚本不停止任何 API，不重试写请求，不执行迁移。

reload 后旧代理 worker 仍可能持有上传、下载和 SSE。SSE 已有 295 秒上限；必须等相关旧代理 worker 退出，才可退休旧 API。保留旧镜像与静态资源至少覆盖发布回退窗口。不要按“reload 后等两秒”删除旧容器。后台模型请求还可能在 HTTP 取消后继续运行，API 退出会等待其执行器完成。

安全退休使用 [retire_release.py](../scripts/retire_release.py)：确认活动槽位、代理已排空、目标镜像身份后禁用旧容器自动重启并发 SIGTERM，等待正常退出；超时保留进程并报错，不发 SIGKILL。API 和 worker 最多会同时占用两份进程内存／连接池；发布前检查余量。新旧 worker 的供应商并发仍受共享池约束，不能提高配置来掩盖发布积压。

## 后台进程独立更新

API-only 发布不更新后台。兼容 worker 更新时，先对旧 worker 发送排空信号，保留其续租线程，再用新镜像启动新的领取实例，完成后核对任务与结算且旧容器正常退出。`retire_release.py worker` 不等待整个集群空闲，只等待该实例已接受的阶段。替代实例可用 `docker compose run -d --name <新实例名> --no-deps control-worker`，角色与镜像身份必须匹配；后续运维须将该显式名称纳入监控。

maintenance 保持单活：先退休旧实例（含计费维护线程结束），再修改 `MAINTENANCE_IMAGE` 并 `up -d --no-deps --wait maintenance`。短暂停止维护不停止 API；禁止未验证的多副本清理。若阶段语义不兼容，全部旧任务先排空再升级，不能借蓝绿切流绕过业务兼容限制。

## 官网与后台独立发布

### 官网匿名图片体验

此功能需先升级 API／控制进程和数据库，再发布官网，不能只替换静态页。`website_guests_0010` 保留原用户 ID、OIDC subject、任务和账本，新增 guest 身份与三张会话／预算表；先在备份库演练、停旧进程、显式迁移，再启动支持新结构的全部进程。旧版不支持游客，禁止混跑或仅回退镜像。

在 `.env.server` 配置 `GUEST_ORIGIN`（精确官网 HTTPS origin，无尾斜线）、真实 `TURNSTILE_SITE_KEY`／`TURNSTILE_SECRET_KEY`、至少 32 字符的独立随机 `GUEST_HASH_SECRET`，最后设置 `GUEST_ENABLED=true`。全部 API 槽位共享稳定 HMAC 密钥；更换会重置网络身份，不应随发布轮换。密钥缺失或生产使用测试密钥拒绝启动。三项每日预算的环境变量仅用于首次初始化，日常通过[后台系统设置](SYSTEM_SETTINGS.md)调整并即时生效，默认值为每位访客 5、同网 100、全站 10000；`GUEST_GLOBAL_CONCURRENCY` 仍由环境变量配置，默认 4。关闭开关拒绝新任务但保留已有任务读取。

Turnstile 选择 Managed widget、仅允许官网 hostname；校验服务使用官方 [Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)，校验 action、hostname，失效和重复 token 拒绝。静态发布为16 语翻译页生成 Cloudflare script/frame/connect 和 blob 图片 CSP，其他页面不放宽；工作台 no-store/noindex，浏览器历史仅本地保存。

上线前必须核实真实 IP 信任链：公网请求只进入 OpenResty／受信 Cloudflare，API 槽位不开放公网；代理覆盖 `X-Forwarded-For`，仅受信 Cloudflare 网段可提供 CF-Connecting-IP。应用只读取处理后的 `request.client.host`，不自行信任用户头。当前容器内 Uvicorn 信任代理头的前提是回环端口和私网访问隔离；若改变拓扑，改为精确可信代理地址。不可用 Cookie 或 Turnstile 替代该检查。

在真实域名独立验收 Turnstile、Cookie、5 次／同网限制、登录账户复用、Redis 故障拒绝、24 小时过期、任务恢复，再开放。代理池／真人打码无法彻底识别为同一个人，全站硬预算为成本底线，边缘 WAF／速率规则作为额外保护。生产不能挂载或暴露 `tests/manual_website_translation_server.py`。

从仓库根目录分别构建；只改一个前端时只执行对应目标：

```sh
docker build -f backend/Dockerfile.static --target website --output type=local,dest=artifacts/site-export .
docker build -f backend/Dockerfile.static --target admin --output type=local,dest=artifacts/admin-export .
python scripts/prepare_static_release.py website --source artifacts/site-export/site \
  --manifest artifacts/site-export/extension-release.json --destination /opt/1panel/www/node-comics \
  --release <官网版本> --oidc-origin https://auth.nodelane.net
python scripts/prepare_static_release.py admin --source artifacts/admin-export/site \
  --destination /opt/1panel/www/node-comics --release <后台版本> --admin-path <当前私有入口> \
  --oidc-origin https://auth.nodelane.net
```

产物在 `releases/<website|admin>/<版本>/site`，对应 `release.inc` 仅含静态路由；版本目录禁止覆盖。脚本拒绝私密文件、符号链接和保留 API 路径，按页面生成 CSP，保留账户页面 no-store、规范 URL、16 语 404 与下载 308。后台使用当前非保留的私有 `/name/` 入口，不更改 OIDC 回调。`design-tokens.css` 与 Picker 继续复用既有独立位置。

将候选 `release.inc` 通过同一事务式脚本激活：

```sh
python scripts/switch_release.py static --release <新官网版本> --previous-release <旧官网版本> \
  --candidate-file /opt/1panel/www/node-comics/releases/website/<新官网版本>/release.inc \
  --active-file /opt/1panel/www/node-comics/active/website.inc \
  --probe-url https://comics.nodelane.net/ --openresty-container <实际容器名>
```

后台独立替换 `active/admin.inc`，探测 URL 使用私有入口，不能写入默认访问日志。回退同样激活旧版本的 include。所有带哈希资源合并到只追加的 `assets` 池，重名而内容不同立即拒绝，已打开旧页面与回退仍可取旧 chunk。不自动清理：维护时仅删除已不被保留版本引用且超出回退／客户端缓存窗口的资源。公开 HTML 可能被 CDN 注入，验收内容、资源与交互，不只比较 HTML 哈希。

## 本地演练

演练用随机项目名创建隔离 PostgreSQL、模拟统一 Redis、真实 OpenResty 与两个 API；仅图片供应商是合成实现，不调用付费模型。不会读取服务器配置或操作现有 Docker 项目。

```powershell
docker build --build-arg RELEASE_ID=rehearsal-blue -t node-comics-backend:deploy-blue backend
docker build --build-arg RELEASE_ID=rehearsal-green -t node-comics-backend:deploy-green backend
docker build -f backend/Dockerfile.static --target website --output type=local,dest=artifacts/deployment-build/website .
docker build -f backend/Dockerfile.static --target admin --output type=local,dest=artifacts/deployment-build/admin .
python scripts/tests/test_deployment.py
python scripts/tests/rehearse_deployment.py
```

需要后端 Python 依赖。报告写入忽略的 `artifacts/deployment-rehearsal/`；默认清理本轮容器／卷／网络，`--keep` 仅供手动检查。演练包含持续请求、切换／回退、错误配置与版本不符恢复、慢上传、SSE、worker 排空、UUID 重放、独立静态发布及基础设施不变检查。测试代理采用官方 [OpenResty Docker](https://github.com/openresty/docker-openresty) `1.29.2.4-1-alpine`，摘要固定在演练脚本，组件许可随官方镜像保留。Docker Desktop 内部代理使用 IPv4 宿主地址；生产模板仍为回环端口。单机演练不证明真实 OIDC、支付、远端 GPU 或生产延迟，也不证明未来任意版本可兼容混跑。

## 插件安装包

1. 在 `apps/extension` 设置正式 `VITE_API_BASE`、`VITE_DRIVE_CONNECT_URL`，更新版本并完成 `npm run check`、`npm test`。
2. 分别生成 Chrome／Edge 手动安装包与无 `manifest.key` 的商店包。Firefox 审核包运行 `npx --no-install web-ext lint --source-dir .output/firefox-mv3`；公开下载使用 AMO 已签名 XPI。
3. 在 [extension-release.json](../backend/extension-release.json) 追加平台、版本、文件名、大小、SHA-256 和该安装包的 `download_url`。通过外部工具将包上传到公开 R2 后，粘贴完整、永久、无签名的 HTTPS URL；不根据桶名、域名或文件名猜测地址。保留已有 `/downloads/...` 的 `path`，更新 `current` 与 `current_by_browser` 中已就绪版本。Firefox 新版尚未取得 AMO 签名时，旧包可以保留为历史下载，但此次协议切换不能将它当成兼容更新；官方翻译入口须遵循上述就绪顺序。
4. 从仓库根目录校验本地包、清单，以及已填写下载 URL 对应的公开文件：

```powershell
python scripts/verify_extension_release.py --browser <chrome|edge|firefox> --zip <安装包路径> --manifest backend/extension-release.json
```

脚本只校验，不执行上传。它核验包身份及正式 API，Firefox 另核对 AMO 官方摘要与签名；已填写的公开文件须与清单大小和 SHA-256 一致。独立重建并发布官网以更新发行清单和下载重定向，无需重启后端；商店提交包不作为手动安装包交付。

官网按钮直接链接各包的 `download_url`，旧 `/downloads/...` 路径仅返回到同一 URL 的静态 308。后端不签名、不代理包文件，不需要 R2 密钥或本地安装包卷。未填写有效 URL 时，16 语官网显示暂不可下载，旧路径返回 503；填写并验真后再提供下载，不使用占位地址。

## 上线检查

- 核对镜像、数据库、控制进程、节点版本与心跳，分别确认 `/health/ready` 与 `/health/cluster`。
- 实际完成 OIDC 登录、临时原图上传、v3 节点直读/交付、原图终态删除与中心鉴权下载；支付按配置渠道独立验证。
- 检查16 语页面、商店入口与平台下载。设置 `WEBSITE_PREVIEW_URL` 后运行 `node scripts/verify_website_download.mjs`，核对包文件名、大小与摘要。
- 运行记录保存在部署环境或忽略的产物目录；仓库文档只维护流程。
