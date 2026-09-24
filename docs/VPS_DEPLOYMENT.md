# VPS 部署与核验

本文记录最近一次 2026-09-24 已验证部署；它不是持续的线上状态查询。历史发布流水、镜像摘要及旧数据库记录从 Git 与服务器私有发布记录查询；源码更新不代表已经上线。

## 2026-09-24 Edge Google Drive 顶层授权

- 已先核对实际 OpenResty 配置与容器挂载：连接页宿主机目录为 `/opt/1panel/www/sites/comics-drive-connect/`。本次只原子更新 `connect.js`，备份为 `/opt/nodelane/node-comics/drive-oauth-20260924T141020Z/backup/connect.js`。`config.js`、HTML、CSS、代理配置哈希保持不变；未部署 API 或数据库。
- 公网 `https://comics.nodelane.net/drive-connect/connect.js` 返回 HTTP 200，与本地文件逐字节一致，SHA-256 为 `03fbe2936384d8041cfbb234047eddee72996bfe538a81f3a148ac9970e4cbf1`，保留 `no-store, no-transform` 和 `nosniff`。部署报告及截图在本地忽略目录 `artifacts/drive-oauth-deploy/`。
- 需同时更新插件：新版后台支持一次性 OAuth state 和 Google 页面往返，新版网页对不支持该协议的旧网页授权客户端提示更新。Edge 0.2.0 ZIP 已重新生成，打包路径为 `apps/extension/.output/node-comicsextension-0.2.0-edge.zip`；这不是商店上架或 R2 下载目录发布。Chrome 托管连接仍保留原有模式。
- 163 项相关单测通过，类型、模块和语言检查通过。真实 Edge 153 隔离 profile 禁用第三方 Cookie 后，模拟 Google 回归覆盖 CBZ / MOBI 导入、取消、失败与阅读位置恢复；隔离 Chromium 的模拟 Chrome Identity 回归覆盖重启恢复、断开。
- 公网入口实测：真实 Edge 153 禁用第三方 Cookie，新包通过线上连接页成功跳转真实 Google 登录页。Google Web OAuth 完整回调地址已由用户确认添加；2026-09-24 用户随后确认新流程已手动测试通过并授权提交推送。自动化未代用户登录真实账户，用户确认与隔离回归分别作为验收证据。

## 2026-09-24 Drive 文件夹与未知类型显示修复

- 修复提交 `e736d38` 已推送至 `main`，线上仅原子替换 `/drive-connect/connect.js`：显示文件夹供浏览、禁止整目录选择，取消 MIME 过滤以免未知类型 MOBI 被隐藏。导入后的格式、权限和内容核验保持有效，无需重发插件包。
- 服务器备份位于 `/opt/nodelane/node-comics/drive-picker-e736d38/backup/`，同目录上级保存部署脚本与验证记录。OAuth 配置哈希不变；未更新 API、数据库、代理配置或其他静态文件。
- 公网脚本 SHA-256 为 `de47c9d8252ebb39a3f430c08a0e02d39c36de1e5a276cf412c6a8e04577e6fd`，HTTP 200，保留 `no-store, no-transform`。本机 Chrome 公网核对六项资源与源码一致，无页面异常，直接访问的插件入口校验正常；截图和报告位于 `artifacts/drive-picker-e736d38/`。
- 81 项相关测试通过；隔离 Chrome 的模拟 Google / Identity MOBI 回归覆盖选择器配置、导入、位置恢复、失败、重启和断开。真实账户中的目录导航及用户具体 MOBI 文件尚未验收。

## 2026-09-24 插件 0.2.0 与云盘页更新

- 插件 `package.json` 与 lockfile 升级为 0.2.0，生成 Chrome MV3、Firefox MV3 和 Firefox 审核源码 ZIP。构建写入正式 API / Drive URL；Chrome 保留既有 OAuth client，Firefox 使用网页授权。包、SHA-256 清单和验证日志位于本地忽略目录 `artifacts/release-0.2.0/`。
- Chrome 包 6,758,659 字节，SHA-256 `848001abd2aa4cf908239cc41ed78e18bdf68a2d92a1529452a9ec0aba2ce245`；Firefox 包 6,758,560 字节，SHA-256 `9fe349242e6286d3a905ae34c4e9263f854ac18dbd8d90a8487e936c6334ccac`。本次仅打包，未签名或提交商店，官网下载仍为 0.1.1。
- 美国 VPS 云盘页更新 `index.html`、`style.css`、`connect.js`；实际 `config.js` 哈希保持不变。此前线上缺少 `/design-tokens.css`，现同步官网共享令牌到静态目录并增加 OpenResty 精确路由，无需重建 API 镜像。
- 原云盘页和代理配置备份于服务器私有目录 `/opt/nodelane/node-comics/drive-release-0.2.0-20260924-1720/backup/`。OpenResty 配置检查、重载以及五个公网资源的逐字节和安全响应头核对通过。API 镜像、数据库和后台进程未更新。
- 公网 Chrome 桌面检查通过：页面、脚本、样式、图标均与源码一致，21 个共享样式变量已加载，无横向溢出或页面异常；直接访问正确提示从插件入口打开。截图与报告保存于同一本地产物目录。
- 插件类型、模块和 i18n 检查通过，835 项测试通过、1 项跳过。新包通过隔离 Chrome 的网页授权 CBZ 与托管授权 MOBI 回归，覆盖文件选择、阅读位置恢复、失败处理、重启和断开；Google 服务为模拟，未重新验证真实账户授权。
- Firefox `web-ext lint` 为 0 错误、18 条警告，涉及跨浏览器 API 和打包依赖中的动态导入、HTML、PDF 求值代码。未声称 Firefox 真实浏览器运行或商店审核通过。

## 2026-09-24 发布

- 后端业务提交 `ee95a5d`，API、control-worker、maintenance 统一使用 `docker.nodelane.net/nodelane/node-comics:20260924-ee95a5d`；镜像已推送到既有仓库。摘要为 `sha256:0ef26001f19f6c6669e0098f465651d2bfa86a547c0d1fe3035c67c29bf0750f`。
- 用户本次明确授权清库重建。先演练新基线的配置恢复、确认无在途任务，再备份并重建专用 `nodecomics_production` 到 `translations_0001`。用户、图片访问、翻译任务、额度账本和订单记录清空；R2 对象及其他数据库未删除。
- `.env.server` 字节级保持不变；复用文本供应商及版本、4 个节点及原凭据、系统设置和计费目录。普通每分钟上限继续保留线上既有 30，PLUS 100，未用源码默认 10 覆盖。被替代的旧业务表不恢复。计算节点重启后完成真实注册，重新确认配置版本和心跳。
- 清库前完整 custom dump、SHA-256 清单和配置快照保存在服务器私有目录 `/opt/nodelane/node-comics/backup-before-20260924-ee95a5d`，目录 0700、文件 0600。未上传数据库备份到 Git，也未建立自动备份任务。回退旧镜像需要配套旧数据库恢复，不能直接连接新基线。
- Google Drive 固定连接页为 `https://comics.nodelane.net/drive-connect/index.html`，复用既有 Web / Chrome OAuth client 与 Picker key。已核对正式 OAuth 来源，并设置 key 的生产网站与 Picker iframe 来源限制；只允许 Drive / Picker API。静态页通过独立 OpenResty 路径发布，禁止缓存及 CDN 改写，实际配置不入库。详见 [Drive 配置](../apps/drive-connect/README.md)。
- 官网当前下载升级为插件 **0.1.1**，写入正式 API / Drive URL，保留 0.1.0 历史下载。新包 7,144,656 字节，SHA-256 `c43a0477071da43876a30d30d3ff9794ddbeb68baa1535aacd409476e8753880`，已验证私有 R2 上传回读及真实浏览器公网下载。没有提交 Chrome 商店更新；旧插件需要更新到新接口版本。
- 验证：插件 725 通过、1 跳过，后端本机 737 通过、146 跳过；隔离 PostgreSQL 首轮 879 通过、3 跳过，1 个迁移测试夹具遗漏支付配置隔离，修正后两个相关用例通过。后台 14 项、官网 12 项通过；后台、官网、插件构建完成。阅读器浏览器验收覆盖独立 UUID、优先当前页、后三页预取、丢失响应恢复、限流恢复与长轮询；Drive 网页 / Chrome 两种模拟授权模式均通过。
- 线上检查：三个容器 healthy，公网 readiness 的数据库、控制进程、OIDC、执行池和计算节点均 ready；五语下载页、ZIP 文件名 / 大小 / 哈希、四个 Drive 资源及安全响应头已核验。模拟 Google 不等于真实账户授权或长期续期通过；本次未发起付费图片翻译或真实支付。

当次脱敏检查与浏览器截图位于本地忽略目录 `artifacts/release-20260924/`、`artifacts/extension-download/`、`artifacts/reading-translations-validation/` 与 `artifacts/source-architecture/drive/`。服务器 `/opt/nodelane/node-comics/release.json` 保存实际镜像与私有备份位置。

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
