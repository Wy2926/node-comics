# 美国 VPS 服务端部署

2026-09-16 已公开部署当前服务端。本机 RTX 4060 Laptop GPU 作为独立计算节点，通过 HTTPS 拉取工作；没有向 VPS 部署图像引擎、模型或阅读器前端。管理后台是 API 镜像内自带的管理界面。

后续隐匿入口改动已在本地实现，尚未部署，因此以下 `/admin/` 仍是上次上线记录。下一次发布前，先将新的 `ADMIN_WEB_PATH` 对应完整回调登记到 Logto，保留客户端回调；再在 VPS 的私有 `.env.server` 设置同一路径并更新镜像及 OpenResty。未配置该项时新版关闭后台页面。具体顺序见[后台入口与登录](ADMIN_CONSOLE.md#登录)。

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
| 本机节点 | `DESKTOP-29CQPLR:cuda:0`，1 个执行位，16 种目标语言，`mit-95227a2-classic-v8-qt` |

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

## 本机计算节点

私有配置在 `private-test-data/production-node/`；`node.json` 仅含该节点凭据和本机引擎凭据，`engine.json` 指向本机已有模型、字体和设备锁目录。服务端不接收本机登录 Cookie，节点不持有数据库、R2 或模型供应商密钥。

本次已在后台启动；后续在仓库根目录运行：

```powershell
./scripts/start-remote-node.ps1
# 另一终端请求停止；先停止新领取，当前阶段完成后退出。
./scripts/start-remote-node.ps1 -Stop
```

这组脚本只启动图像引擎和计算代理，不启动本地 API、数据库或控制任务进程。`processes.json` 记录当前 PID，日志保留于同一个私有目录。本次没有安装开机自启或计划任务；本机关机、睡眠或节点停止时，常规图像阶段会等待节点恢复，`/health/ready` 会反映计算节点不可用。

## 管理员身份

已通过 Logto 管理页面创建 User 类型的 `node-comics-admin` 角色，并分配给操作者指定的账号。后续在 Logto 的角色用户列表管理授权；不要手动修改漫画库的 `users.role`，后端会按登录令牌重新同步。

已配置用户访问令牌自定义声明，脚本保存在 [logto-comics-claims.js](../deploy/logto-comics-claims.js)。只有 audience 包含 `https://comics.nodelane.net/api` 的令牌才加入该管理员角色；不读取前端传入的角色、不根据邮箱自动授予权限。Logto 页面运行测试通过：管理员得到对应角色，普通用户得到空角色列表，其他 audience 返回空扩展声明。配置方式参考 [Logto 自定义访问令牌说明](https://docs.logto.io/developers/custom-token-claims/create-script)。

角色变更后需重新登录取得新访问令牌；既有令牌在过期前仍保留签发时的权限。本次已经核实角色分配和脚本保存，尚未使用指定账号完成漫画后台的真实登录。

## 验证与边界

- 生产配置预检及 PostgreSQL 18.6 的实际迁移成功；三个服务与计算节点健康，公网 `/health/ready` 返回 200，全部依赖 ready。
- R2 使用独立临时合成图片验证写入、读取、签名下载和精确网页 CORS，字节一致；临时对象随后删除。原有 CORS 规则保留，增加生产域名。未签名读取未返回图片。
- 管理后台页面与静态资源正常，浏览器可跳转到真实 Logto 登录页。已有插件回调保留，新增 `/admin/` 回调和精确 CORS 来源；改动前元数据备份在 VPS 私有服务目录。
- 身份服务拒绝 Python 默认 User-Agent，现用明确的 `NodeComics/0.3` 获取公钥，保留原有签名、issuer、audience、过期及公钥撤销校验。
- 修复 PID 1 不处理 SIGTERM 导致容器更新等待的问题。控制进程停止新领取并通过线程池等待在途阶段完成；维护进程完成当轮后退出。线上空闲停止两个进程耗时 0.55 秒，均退出码 0，并已恢复。
- OIDC、身份配置与健康相关 44 项测试通过；健康、恢复、调度与节点相关 72 项测试通过（两组有重叠，不能相加为独立用例总数）。
- 新增独立子进程信号测试通过：SIGTERM 发生于阶段执行期间时，不再领取新任务，已领取阶段完成后进程才正常返回。
- 本次没有发起收费图片模型调用或新的整页常规翻译；已有 OpenAI 图片供应商 Key 为空，AI 重绘尚不可用。管理员角色已配置；不能将 JWKS、登录页可达或声明脚本测试等同于真实登录验收。
