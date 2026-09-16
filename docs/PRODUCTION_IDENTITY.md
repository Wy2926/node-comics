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
