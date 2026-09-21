# 美国 VPS 服务端部署

## 2026-09-21 四页阅读窗口与随机昵称发布、清库重建

- 源码提交 `f362460` 已部署美国 VPS。镜像 `docker.nodelane.net/nodelane/node-comics:20260921-f362460`，摘要 `sha256:bf9bb0fa8afe5d4babad122ab77f9727a987c7ba023d605b0031f134021bbf96`；由该提交的源码在 VPS 构建、推送，三个控制服务均运行新镜像。
- 按本次明确授权停止服务、备份并删除重建专用数据库 `nodecomics_production`，初始化为 `payments_0001`。重置前 1 个用户、40 个任务（38 成功、2 无字），没有在途任务。重建后、启动前核实用户、任务、资产、订单、价格、供应商与节点表均为 0；其他数据库名称及 OID 未变，身份服务和 R2 对象未修改。
- 私有重置前备份位于 VPS `/opt/nodelane/node-comics/backup-before-f362460/`，包含可解析的 PostgreSQL custom dump、SHA-256 清单和旧发布配置，目录 0700、文件 0600，不进入 Git。新发布及脱敏验收记录为同目录上级的 `release.json`、`verification-f362460.json`。
- 启动后按代码自动建立三个控制资源池、默认系统设置和两条 PLUS 草稿价格；旧业务数据未恢复。验收时用户、任务、图片授权、订单、供应商和外部图像节点仍为 0。
- 公网首页与 `/health/live` 返回 200，未认证 `/v1/me` 返回 401；`/v1/capabilities` 确认 `max_plan_items=4`，容器源码确认新用户使用持久化 `NodeLane_` 随机昵称。没有为验收创建真实用户、翻译任务或支付交易。
- 数据库、控制工作进程、维护进程、OIDC 和控制池就绪；清库删除了图像节点注册，保留 `CLASSIC_ENABLED=true`，因此 `/health/ready` 返回 503，唯一未就绪项为 `compute-nodes`。需重新配置供应商和注册节点后恢复翻译，不能将本次部署描述为翻译能力已就绪。
- `.env.server` 按字节校验保持不变。现有 `FREE_IMAGES_PER_MINUTE=30` 会重新播种分钟设置；`FREE_DAILY_PAGES` 未显式配置，采用代码默认 30。若需要已确认的普通用户每分钟 10 张，应另行调整服务器配置和后台系统设置。支付目录为草稿，需重新配置启用。


## 2026-09-21 免费套餐默认额度调整

- 应用源码提交：`21bdab2`，已推送 `origin/main`。普通用户默认每日 30 页常规翻译、每滚动 60 秒新增 10 张图片；PLUS 不变。配置示例、五语官网、相关夹具、测试与规则文档已同步。
- 镜像：`docker.nodelane.net/nodelane/node-comics:20260921-21bdab2`，摘要 `sha256:b51a23c8c40bd0fb651ddbcc6ec5b1a4856fe8c6b4fc77fdf357f8484ce9d45e`。由该提交源码在 VPS 构建并推送，三个服务均已切换且 healthy，源站 `/health/ready` 返回 200。
- 按用户要求未修改 `.env.server` 或后台持久化业务设置；仅更新发布镜像引用。管理员需手动设置 `FREE_DAILY_PAGES=30` 并重建服务容器，以及后台系统设置 `free_images_per_minute=10`。已持久化分钟设置不会被环境变量种子覆盖，已生成的日额度桶不会回写，新日周期采用新额度。
- 隔离 Docker 下额度、赠送、分钟准入、系统设置及 PostgreSQL 并发共 68 项测试通过；插件相关 42 项、官网 12 项测试通过；前端类型检查和 110 页静态构建通过。本地浏览器检查中英文定价与截图，公网浏览器核实五语定价均展示每日 30 页和滚动分钟 10 张。未调用真实翻译或支付。
- 旧镜像 `20260921-2d01c59` 保留；服务器保存 `.env.before-21bdab2`、`release-before-21bdab2.json`，最新发布信息写入 `release.json`。

## 2026-09-21 官网示意图更新

- 源码提交：`2d01c59123aac9e1ecd0e1d47249af8dd99a2387`，已推送 `origin/main`。
- 镜像：`docker.nodelane.net/nodelane/node-comics:20260921-2d01c59`，摘要 `sha256:05b680686a3daaedc026db4e917d9d05b1d45108ab01802b71969dd8065e68cb`；服务器从该提交的源码构建并推送镜像仓库，三个服务已切换。
- 官网替换中文示意图并添加英文、韩文，与日文原图组成四种切换；完整展示漫画，加载与解码期间显示动画，失败可重试，窄屏双列按钮。
- 12 项单测、类型检查、110 页静态构建通过；本地和公网 Chrome 均验证五语页面、四张图片、320／390／1440px 示意图布局、延迟加载、失败重试、快速切换和滚动位置保持。执行入口为 `scripts/verify_website_compare.mjs`。
- 发布后 `api`、`control-worker`、`maintenance` 均 healthy，源站首页和 `/health/ready` 返回 200；此为本次实际状态，取代下方上一轮缺少节点的就绪记录。未改动数据库、供应商及节点配置，未调用翻译或支付。
- 前一镜像 `20260921-6047349` 保留；服务器保存 `.env.before-2d01c59`、`release-before-2d01c59.json`，最新发布信息写入 `release.json`。

## 2026-09-21 发布

- 源码提交：`6047349e5128b767ddad0fcaa7e127aa22000b23`，已推送 `origin/main`。
- 镜像：`docker.nodelane.net/nodelane/node-comics:20260921-6047349`，摘要 `sha256:498560e5c6cebd0ea5ee7793d135c22af7e9e7ac8fb00651f313b621db509e96`，已构建、推送并在美国 VPS 上运行。
- 按用户明确授权删除并重建项目专用数据库 `nodecomics_production`，由实际旧基线 `reading_0001` 重建为 `payments_0001`；其他业务数据库及已有 R2 对象未删除。旧用户、任务、供应商、节点注册及支付目录未恢复。
- 官网、API、私有管理后台由同一镜像提供；OpenResty 根路径已开放给官网，旧 `/admin/` 返回 404。沿用服务器私有 `ADMIN_WEB_PATH` 及已有管理员回调，向同一 Logto 客户端补充官网回调 `https://comics.nodelane.net/auth/callback/`，保留其他回调。
- 12 项官网单测、类型检查、110 页构建及 51 项网站／后台／身份相关后端测试通过。Chrome 完成五语定价与账户夹具验收；公开首页、定价、账户、英文首页、sitemap、404 与未认证 API 状态符合预期；真实官网可跳转到 Logto 登录表单，但未替用户完成登录。
- 线上支付目录为空、支付渠道关闭，定价页显示订阅暂未开放。未调用收费翻译或支付接口。公网定价交互回归使用模拟报价，不能视为生产支付配置已完成。
- 清库后无用户和图像计算节点，仅自动建立三个控制资源池。数据库、控制工作进程、维护进程、OIDC 和控制池就绪；原配置仍为 `CLASSIC_ENABLED=true`，所以 `/health/ready` 因缺少图像节点返回 503。官网、API 及私有后台可访问，但常规翻译尚不可用；需明确选择保持空库并关闭常规模式，或重新配置节点与供应商后完成全量就绪验收。

服务目录仍为 `/opt/nodelane/node-comics`，实际发布记录见其中 `release.json`、`verification.json`，私有配置不提交仓库。计算节点使用当前整页协议，接入见[节点配置](NODE_CONFIGURATION.md)。

## 历史记录：2026-09-16

以下保留首次部署的配置和检查证据，旧镜像、数据库基线、后台路径与节点状态均不代表当前部署。2026-09-19 曾发布 `f0bc543` / `reading_0001`，2026-09-21 已替换。

## 实际部署

| 项目 | 当前配置 |
| --- | --- |
| API / 管理后台 | `https://comics.nodelane.net` / `/admin/` |
| VPS | 现有美国 SSH 主机 `147.125.241.37` |
| 服务目录 | `/opt/nodelane/node-comics` |
| Compose | [compose.server.yaml](../deploy/compose.server.yaml)，项目 `node-comics-production` |
| 进程 | `api`、`control-worker`、`maintenance` 三个容器 |
| 镜像 | `docker.nodelane.net/nodelane/node-comics:20260916T081706Z-75cca73-ops` |
| 镜像摘要 | `sha256:5c399c1736e79023d1c3f22bf8858e4e1d4b8f5d42eabddd4464ca8de04672e8` |
| 数据库 | 复用 PostgreSQL 18.6 容器 `1Panel-postgresql-puHh`；新库及独立账号 `nodecomics_production` |
| 数据库迁移 | `shared_0003_system_settings`；本次在全新空库执行，没有迁移或清空其他业务库 |
| 容器网络 | 复用 `1panel-network` |
| 反向代理 | 现有 OpenResty，经 `127.0.0.1:18088` 访问 API；公网仅使用 HTTPS |
| 图片存储 | 私有 R2，独立前缀 `node-comics-production/`，原图和译图无限期保留 |

镜像基于提交 `75cca73`，额外包含本次 OIDC User-Agent 和进程停止信号修复；这些工作区改动尚未提交。服务端队列使用 PostgreSQL，不连接现有 Redis，不改动其数据或配置。新数据库账号不是 PostgreSQL 超级用户。

插件或本地阅读器的 API 基础地址应设为 `https://comics.nodelane.net`；本次仅部署服务端，没有重新发布客户端。

配置文件 `.env` 保存镜像标签、外部网络、端口；`.env.server` 保存生产环境变量与密钥，两者在 VPS 上权限为 `0600`，服务目录为 `0700`。模板见 [.env.server.example](../deploy/.env.server.example)。不将真实配置复制进镜像或提交到 Git。

## 更新与检查

在 VPS 服务目录执行；发布前先从工作区重新构建一个新标签，保留当前标签用于排查。不要仅凭 Git 提交号判断镜像是否包含未提交修复。

```sh
cd /opt/nodelane/node-comics
docker compose --env-file .env -f compose.server.yaml config --quiet
docker compose --env-file .env -f compose.server.yaml run --rm --no-deps api python -m app.config --production
docker compose --env-file .env -f compose.server.yaml run --rm --no-deps api python -c 'from app.db import initialize; initialize()'
docker compose --env-file .env -f compose.server.yaml up -d
docker compose --env-file .env -f compose.server.yaml ps
curl --fail https://comics.nodelane.net/health/ready
```

首次部署前需在既有 PostgreSQL 内创建专用空数据库和非超级用户，再填写 `DATABASE_URL`。此 Compose 不会启动新 PostgreSQL 或 Redis 容器。后续涉及数据库迁移的更新，先按[运维说明](OPERATIONS.md)备份；镜像回退不能代替数据库兼容性检查。本次没有设置自动备份任务。

公网镜像仓库入口实测存在上传大小限制（413）。在 VPS 上可使用其既有本机入口推送相同 repository/tag，公网地址随后可正常读取：

```sh
# 设置一个新发布标签；不要覆盖已发布标签。
VERSION=REPLACE_WITH_NEW_RELEASE_TAG
docker build -t docker.nodelane.net/nodelane/node-comics:$VERSION /path/to/backend
docker tag docker.nodelane.net/nodelane/node-comics:$VERSION 127.0.0.1:7101/nodelane/node-comics:$VERSION
docker push 127.0.0.1:7101/nodelane/node-comics:$VERSION
# 将 .env 中 SERVER_IMAGE 改为新标签，再执行上面的更新与检查命令。
```

反向代理配置见 [openresty.comics.conf](../deploy/openresty.comics.conf)，实际安装为 `/opt/1panel/www/conf.d/comics.conf`。当前复用现有通配符源站证书，Cloudflare 公网 HTTPS 验证通过。代理关闭请求/响应磁盘缓冲和此站点访问日志，避免图片字节落盘及记录登录授权码；API 同样关闭访问日志，容器日志限制为每份 10 MiB、保留 3 份。不要用会展开全部密钥的 `docker compose config` 输出做普通日志。

## 计算节点接入

仓库当前保留计算代理，图像引擎须独立部署并满足[交互协议](COMPUTE_PROTOCOL.md)。节点只持有自身凭据及本机引擎凭据，不持有数据库、R2 或供应商密钥。仓库删除不代表已修改 VPS 或其他机器的运行状态；原有服务状态需另行核实。

## 管理员身份

已通过 Logto 管理页面创建 User 类型的 `node-comics-admin` 角色，并分配给操作者指定的账号。后续在 Logto 的角色用户列表管理授权；不要手动修改漫画库的 `users.role`，后端会按登录令牌重新同步。

已配置用户访问令牌自定义声明，脚本保存在 [logto-comics-claims.js](../deploy/logto-comics-claims.js)。只有 audience 包含 `https://comics.nodelane.net/api` 的令牌才加入该管理员角色；不读取前端传入的角色、不根据邮箱自动授予权限。Logto 页面运行测试通过：管理员得到对应角色，普通用户得到空角色列表，其他 audience 返回空扩展声明。配置方式参考 [Logto 自定义访问令牌说明](https://docs.logto.io/developers/custom-token-claims/create-script)。

角色变更后需重新登录取得新访问令牌；既有令牌在过期前仍保留签发时的权限。本次已经核实角色分配和脚本保存，尚未使用指定账号完成漫画后台的真实登录。

## 验证与边界

- 生产配置预检及 PostgreSQL 18.6 的实际迁移成功；三个控制服务完成部署检查；本文为当时记录，不代表当前运行状态。
- R2 使用独立临时合成图片验证写入、读取、签名下载和精确网页 CORS，字节一致；临时对象随后删除。原有 CORS 规则保留，增加生产域名。未签名读取未返回图片。
- 管理后台页面与静态资源正常，浏览器可跳转到真实 Logto 登录页。已有插件回调保留，新增 `/admin/` 回调和精确 CORS 来源；改动前元数据备份在 VPS 私有服务目录。
- 身份服务拒绝 Python 默认 User-Agent，现用明确的 `NodeComics/0.3` 获取公钥，保留原有签名、issuer、audience、过期及公钥撤销校验。
- 修复 PID 1 不处理 SIGTERM 导致容器更新等待的问题。控制进程停止新领取并通过线程池等待在途阶段完成；维护进程完成当轮后退出。线上空闲停止两个进程耗时 0.55 秒，均退出码 0，并已恢复。
- OIDC、身份配置与健康相关 44 项测试通过；健康、恢复、调度与节点相关 72 项测试通过（两组有重叠，不能相加为独立用例总数）。
- 新增独立子进程信号测试通过：SIGTERM 发生于阶段执行期间时，不再领取新任务，已领取阶段完成后进程才正常返回。
- 本次没有发起收费图片模型调用或新的整页常规翻译；已有 OpenAI 图片供应商 Key 为空，AI 重绘尚不可用。管理员角色已配置；不能将 JWKS、登录页可达或声明脚本测试等同于真实登录验收。
