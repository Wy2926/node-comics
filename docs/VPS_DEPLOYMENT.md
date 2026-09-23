# VPS 部署与核验

本文保留 2026-09-21 最后一次已记录部署的必要信息，不是当前线上查询结果。历史发布流水、镜像摘要及旧数据库记录从 Git 与服务器私有发布记录查询；源码更新不代表已经上线。

## 历史部署基准

- 服务位于 `/opt/nodelane/node-comics`，使用 [compose.server.yaml](../deploy/compose.server.yaml)，项目名 `node-comics-production`；API、control-worker、maintenance 分别运行，复用外部 PostgreSQL 与容器网络。
- 官网／API 为 `https://comics.nodelane.net`；后台路径取私有 `ADMIN_WEB_PATH`，旧 `/admin/` 返回 404。代理实际位置为 `/opt/1panel/www/conf.d/comics.conf`，配置模板见 [openresty.comics.conf](../deploy/openresty.comics.conf)。再次部署先核实实际位置，不直接套用历史路径。
- `f362460` 发布时已获授权备份并重建专用库到 `payments_0001`，未恢复旧业务记录，R2 与其他数据库未改；该历史授权不表示后续发布允许再次清库。
- 最后的下载发布仅替换 API 镜像中的官网、网站路由和版本目录，API 为 `node-comics:20260921-extension-download-v010-final`，另外两个进程仍用 `20260921-f362460`。版本化 ZIP 曾从公网实际下载并核对哈希；发布方法见[官网说明](../backend/website/README.md)。
- 当时 readiness 为 503，唯一未就绪项是计算节点；翻译不能据官网可访问而视为可用。服务器曾保留 `FREE_IMAGES_PER_MINUTE=30` 的旧种子，与源码默认普通 10 张不同，实际持久化设置需重新核实；支付价格为草稿，供应商／节点需配置。
- 备份与回退配置保存在服务器私有目录，配置权限 0600、目录 0700。私密配置、数据库备份与身份信息不提交仓库，不输出会展开密钥的 Compose 完整配置。

## 更新与检查

先核实当前服务目录、镜像、数据库与代理配置，备份后在已确认目录执行；发布前先从工作区重新构建一个新标签，保留当前标签用于排查。不要仅凭 Git 提交号判断镜像是否包含未提交修复。

```sh
cd /opt/nodelane/node-comics
docker compose --env-file .env -f compose.server.yaml config --quiet
docker compose --env-file .env -f compose.server.yaml run --rm --no-deps api python -m app.config --production
docker compose --env-file .env -f compose.server.yaml run --rm --no-deps api python -c 'from app.db import initialize; initialize()'
docker compose --env-file .env -f compose.server.yaml up -d
docker compose --env-file .env -f compose.server.yaml ps
curl --fail https://comics.nodelane.net/health/ready
```

首次部署前需在既有 PostgreSQL 内创建专用空数据库和非超级用户，再填写 `DATABASE_URL`。此 Compose 不会启动新 PostgreSQL 或 Redis 容器。数据库基线不兼容时须另行明确数据处置，先按[运维说明](OPERATIONS.md)备份；镜像回退不能代替数据库兼容性检查。本次没有设置自动备份任务。

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


## 上线检查

计算节点采用当前[整页协议](COMPUTE_PROTOCOL.md)与[节点配置](NODE_CONFIGURATION.md)。管理员权限来自身份中心角色与 [Logto 声明脚本](../deploy/logto-comics-claims.js)，不按邮箱或前端字段授予，不手改数据库角色。

逐项核验实际镜像／数据库基线、控制服务与节点 readiness、OIDC 真实登录、R2 授权读写、网站与插件关键流程。真实翻译和支付按相应接入范围独立验收；健康接口、登录页可达或构建通过不能代替它们。发布与回滚前均检查数据库兼容性，镜像回退不恢复数据库。
