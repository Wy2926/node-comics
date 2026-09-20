# 生产身份配置与验证

后端默认 `APP_ENV=production`。生产启动校验要求 `DEV_AUTH=false`、PostgreSQL、完整 OIDC 配置、私有 R2，以及明确的网页来源或固定扩展 ID。任何一项缺失会在连接数据库、迁移和启动服务之前失败。免密码开发管理员登录仅在显式 `APP_ENV=development` / `test` 且配置至少 32 字符签名密钥时可用。

生产配置使用 [deploy/.env.production.example](../deploy/.env.production.example)；复制为被忽略的 `deploy/.env.production` 后填写真实值。`scripts/bootstrap.ps1 -Production -Start` 选择这份文件，先构建后端并执行无外部访问的配置预检，再启动服务。未传 `-Production` 的引导命令为本地开发入口，会显式标记 `APP_ENV=development`。直接调用 Compose 时需设置 `COMICS_ENV_FILE=deploy/.env.production` 并传入相同的 `--env-file`；否则容器仍默认读取本地环境文件。

```powershell
$env:COMICS_ENV_FILE = 'deploy/.env.production'
docker compose --env-file .env --env-file deploy/.env.production --project-name node-comics-production run --rm --no-deps api python -m app.config --production
```

此预检只验证配置格式，不代表数据库、R2、身份服务可达，也不代表身份服务已经登记正确的资源授权与回调。Compose 的 `config --quiet` 同样不能替代身份校验。

生产引导固定选择独立 Compose 项目，并要求最终生效的 `APP_ENV` 为 production；shell 中残留的开发模式覆盖值会让预检失败，不能通过环境文件表面配置绕过。

## OIDC 必需项

管理后台入口改为私有 `ADMIN_WEB_PATH`，为空时关闭页面。部署前须在 Logto 新增 `https://<服务域名><ADMIN_WEB_PATH>` 精确回调（含尾斜线）；保留插件及其他客户端回调，不改变现有身份端点、Client ID 或 Audience。新入口不会通过公开身份配置返回。迁移顺序见[后台入口与登录](ADMIN_CONSOLE.md#登录)。

| 配置 | 要求 |
| --- | --- |
| `OIDC_ISSUER` | 令牌的精确 issuer，HTTPS |
| `OIDC_AUDIENCE` | API 资源真实 Identifier，不能使用浏览器应用 ID |
| `OIDC_CLIENT_ID` | 已登记的浏览器 / 扩展应用 ID |
| `OIDC_JWKS_URL` | 身份服务 HTTPS JWKS 地址 |
| `OIDC_AUTHORIZATION_ENDPOINT` / `OIDC_TOKEN_ENDPOINT` | HTTPS 授权码及换令牌端点 |
| `CORS_ORIGINS` | 精确 HTTPS 网页来源，不能含路径、通配符或凭据；只服务扩展时可空 |
| `EXTENSION_IDS` | 逗号分隔的固定 32 字符扩展 ID；不允许扩展来源通配符 |

2026-09-16 已重新读取 [Logto 公开 discovery](https://auth.nodelane.net/oidc/.well-known/openid-configuration) 和对应 JWKS：issuer 为 `https://auth.nodelane.net/oidc`，端点为 `/oidc/auth`、`/oidc/token`、`/oidc/jwks`，支持 PKCE S256，公钥为 EC / P-384 / ES384。用户确认应用 ID 为 `dept2iz42nzidf5pao6fo`，与现有本地配置一致。

2026-09-16 用户确认已创建 API 资源，Identifier 为 `https://comics.nodelane.net/api`，线上域名为 `https://comics.nodelane.net`。根 `.env` 已补齐相同 audience；独立 `deploy/.env.production` 使用生产模式、关闭开发登录、精确来源和专用新数据库密码，`COMPOSE_PROJECT_NAME=node-comics-production` 隔离生产卷，`R2_KEY_PREFIX=node-comics-production/` 隔离生产对象。`deploy/.env.local` 已显式标记 `APP_ENV=development`，仍作为本地开发入口。未切换本机运行服务，未公开部署。真实登录验收仍需核实该应用的资源授权、网页 / 扩展回调和允许来源。固定扩展回调为 `https://aiajdjliifeeaogpalejpggkiccjbneo.chromiumapp.org/oidc`；更多已有接入信息见 [实施说明](IMPLEMENTATION.md#logto-接入配置)。

## 撤销与并发行为

插件退出登录清除本机账户会话，身份服务的浏览器 SSO 会话仍可能存在。插件与网页阅读器主动登录统一请求 `openid profile offline_access` 和 `prompt=login consent`，允许输入其他账户并授权自动续期；不触发其他应用的全局退出。依据 [Logto 重新认证说明](https://docs.logto.io/end-user-flows/sign-out) 与[刷新令牌配置](https://docs.logto.io/integrate-logto/application-data-structure)。首次授权必须返回有效的 `access_token`、`token_type=Bearer`、`expires_in` 和 `refresh_token`，由产品 API `/v1/me` 验证身份后建立会话。缺少续期权限时明确报错，不建立缺少必要字段的会话。

### 客户端会话与续期（2026-09-20）

- `src/auth` 统一管理新会话模型：每次登录独立的会话 ID、服务 origin、用户、访问令牌、到期时间、提前刷新时间和 OIDC 续期凭据。扩展只在 `chrome.storage.local` 的 `nc-auth` 中保存一份，限制为 `TRUSTED_CONTEXTS`；网页阅读器在自身 origin 的同名 localStorage 记录保存。凭据不再在阅读器与后台间镜像。旧会话读写已删除，没有旧账户或旧数据迁移、双写与兼容回退；更新后需重新登录。
- 活跃阅读器在令牌到期前最多 60 秒自动续期（短令牌取有效期的 10%）；恢复前台和发起带账户认证的请求时同样检查。关闭页面后不依赖常驻定时器，扩展后台下次工作时按需续期。开发测试会话依照后端 `expires_in=43200` 到期，不能自动重新签发开发身份。
- 通过同 origin 的 Web Locks 合并多页面／后台的续期。刷新请求携带原 client ID 与 API resource；先持久保存轮换后的凭据，再发送业务请求。独立写锁允许用户在续期期间退出或切换账户，迟到结果按会话 ID 和已使用令牌核对，不恢复旧账户。
- 产品 API、需认证的原图上传、同源图片下载与状态长轮询统一处理 401：最多续期一次并以原请求体、原幂等键重试一次；仍为 401，或身份服务明确拒绝续期，清除会话和续期凭据，通知所有阅读器及网页翻译上下文停止旧账户请求。页面显示重新登录入口，图内显示登录操作；保留原图、阅读位置和服务端持久任务。
- 断网、15 秒续期超时、身份服务 429 或 5xx 保留会话，并共享 30 秒续期冷却。仍有效的访问令牌可继续使用；已过期的令牌不会发给业务接口，显示可重试的连接错误。业务 403 不登出。R2 签名 URL 的 401/403 只按原图片授权逻辑更新签名，不触发账户续期或退出。
- 登录可持续多久由实际访问令牌、Logto 刷新令牌及 grant 生命周期共同决定，不在插件内假定固定天数；续期不能保证无限登录。后台 JWT 签名和到期校验继续生效。

客户端验证命令：

```powershell
cd apps/extension
npm run check
npm test
npm run build
npm run dev -- --port 5187
```

浏览器隔离验收入口为 `http://127.0.0.1:5187/tests/auth-lifecycle-fixture.html`。只使用模拟身份服务、模拟产品 API 和本地原创漫画；拒绝非验收数据与外部网络请求。2026-09-20 前端类型／模块检查、304 项测试与 Chrome MV3 构建通过；已在 Chrome 检查自动续期、断网保留会话、撤销与持续 401 后双标签页同步退出、重新登录入口，以及第 2 页原图在失效和重新登录后保持位置；检查了账户页和阅读器截图。真实 Logto 的离线授权、刷新令牌轮换及扩展后台休眠恢复仍需真实环境验收，不能将模拟结果视为线上验证。本机缺少后端测试环境依赖，本轮后端 pytest 未运行成功。

### 服务端撤销与并发

JWKS 只缓存完整公钥集合，默认最长 300 秒，可用 `OIDC_JWKS_CACHE_SECONDS` 缩短到 1–300 秒。单钥无期限 LRU 缓存已经移除。集合到期必须重新获取；获取失败不再使用过期公钥放行。因缓存存在，服务端撤销的公钥最迟在缓存到期后被拒绝，并非瞬时撤销。JWT 继续校验签名、issuer、audience、到期和非空 subject。

同一个 OIDC issuer / subject 首次并发访问时，唯一约束冲突会回滚并复用已提交的用户，所有请求得到同一身份。没有旧身份结构或旧数据兼容路径。

隔离测试命令：

```powershell
cd backend
.venv/Scripts/python.exe -m pytest tests/test_identity_config.py tests/test_oidc.py -q
# 专用 PostgreSQL 测试数据库；连接设置参见 test_postgres_concurrency.py 的 pg_scope。
$env:RUN_POSTGRES_CONCURRENCY = '1'
.venv/Scripts/python.exe -m pytest tests/test_oidc_postgres.py -q
```

已验证配置失败关闭、ES384 / 签名 / issuer / audience / subject、真实 PyJWT 集合缓存的撤销及轮换、过期缓存断网拒绝，以及真实 PostgreSQL 8 路同时首次登录只产生一个用户、冲突后事务可继续、后续角色撤销。测试使用临时密钥和数据库，没有访问真实用户或调用图片模型。真实 OIDC 登录与公开部署仍未验证。
